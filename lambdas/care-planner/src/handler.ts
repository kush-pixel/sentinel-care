import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getLaceForPatient, calculateLaceScore } from "@sentinel/lace";
import { TriageProtocol } from "@sentinel/schemas";
import { getLatestRule } from "@sentinel/validation";
import {
  getFullPatientRecord,
  getPatientEncounterSummary,
  FhirNotFoundError,
} from "../../../scripts/src/fhir/fhir-client";
import { auditDataAccess, auditLog } from "@sentinel/audit";
import { validatePatientId } from "@sentinel/validation";
import { scoreConfidence } from "./confidence";
import { buildCarePlannerPrompt } from "./planner-prompt";
import { callNovaPro } from "./bedrock-caller";
import { generateQuestionAudio } from "./polly-generator";

// ─── DynamoDB client ───────────────────────────────────────────────────────────

function makeDynamo(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  });
  return DynamoDBDocumentClient.from(raw);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (
  event: {
    patientId: string;
    regeneration?: {
      previousReviewId: string;
      rejectionReason: string;
      rejectedAt: string;
      reviewedBy: string;
    };
  }
): Promise<object> => {

  // STEP 1 — Validate input
  if (!validatePatientId(event.patientId)) {
    return { statusCode: 400, error: "Invalid patientId format" };
  }

  // STEP 1b — Log regeneration context if present
  if (event.regeneration) {
    console.log(
      `[REGENERATION] Patient ${event.patientId}\n     Previous review: ${event.regeneration.previousReviewId}\n     Rejection reason: ${event.regeneration.rejectionReason}\n     Requested by: ${event.regeneration.reviewedBy}`
    );
  }

  // Initialise DynamoDB client and table names early so they're available
  // for the idempotency check below and reused throughout the rest of the handler.
  const dynamo        = makeDynamo();
  const patientsTable  = process.env["DYNAMO_TABLE_PATIENTS"]  ?? "PatientProfiles";
  const protocolsTable = process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols";
  const reviewsTable   = process.env["DYNAMO_TABLE_REVIEWS"]   ?? "ProtocolReview";

  // STEP 1c — Idempotency: skip if an active (non-rejected) review already exists.
  // Only applies to fresh runs — regeneration requests always produce a new record.
  if (!event.regeneration) {
    const existing = await dynamo.send(new ScanCommand({
      TableName: reviewsTable,
      FilterExpression: "patient_id = :pid AND #s IN (:pending, :auto, :approved)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":pid":      event.patientId,
        ":pending":  "PENDING_REVIEW",
        ":auto":     "AUTO_APPROVED",
        ":approved": "APPROVED",
      },
    }));
    if ((existing.Count ?? 0) > 0) {
      const item = existing.Items![0] as Record<string, unknown>;
      const existingStatus   = String(item["status"]    ?? "");
      const existingReviewId = String(item["review_id"] ?? "");
      console.log(`[IDEMPOTENT] Active review ${existingReviewId} (${existingStatus}) already exists for ${event.patientId} — skipping`);
      return {
        statusCode:  200,
        patientId:   event.patientId,
        reviewId:    existingReviewId,
        status:      existingStatus,
        skipped:     true,
        message:     `Protocol review already exists for patient ${event.patientId}`,
        questionPriority: (item["protocol"] as { question_priority?: string[] } | undefined)?.question_priority ?? [],
      };
    }
  }

  // STEP 2 — Load FHIR patient
  let patientRecord: Awaited<ReturnType<typeof getFullPatientRecord>>;
  try {
    patientRecord = await getFullPatientRecord(event.patientId);
  } catch (err: unknown) {
    if (err instanceof FhirNotFoundError) {
      return { statusCode: 404, error: "Patient not found in FHIR" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { statusCode: 500, error: "FHIR read failed", details: msg };
  }

  auditDataAccess(event.patientId, "CARE_PLANNER", "FHIR patient record loaded");

  // STEP 3 — Get LACE score (PatientProfiles first, FHIR fallback)
  const conditionCodes = patientRecord.conditions
    .flatMap((c) => c.code.coding)
    .map((coding) => coding.code)
    .filter((code): code is string => !!code);


  const storedLace = await getLaceForPatient(event.patientId, dynamo, patientsTable);

  let laceResult: NonNullable<Awaited<ReturnType<typeof getLaceForPatient>>>;

  if (storedLace) {
    laceResult = storedLace;
    console.log(
      `[LACE] PatientProfiles: score=${laceResult.totalScore} risk=${laceResult.riskLevel}`
    );
  } else {
    // Fall back to FHIR calculation
    const dischargeDateExt = patientRecord.patient.extension?.find(
      (e) => e.url === "discharge-date"
    )?.valueDate ?? new Date().toISOString().slice(0, 10);

    const encounterSummary = await getPatientEncounterSummary(
      event.patientId,
      dischargeDateExt
    );

    laceResult = calculateLaceScore({
      admissionDate: encounterSummary.admissionDate,
      dischargeDate: encounterSummary.dischargeDate,
      admissionType: encounterSummary.admissionType,
      conditionCodes,
      recentEDVisits: encounterSummary.recentEDVisits,
    });

    // Store in PatientProfiles so future runs skip FHIR
    const calculatedAt = new Date().toISOString();
    await dynamo.send(
      new UpdateCommand({
        TableName: patientsTable,
        Key: { patient_id: event.patientId },
        UpdateExpression: [
          "SET lace_score               = :ls",
          "    lace_risk_level          = :lr",
          "    lace_components          = :lc",
          "    lace_length_of_stay_days = :ld",
          "    lace_charlson_score      = :cs",
          "    lace_interpretation      = :li",
          "    lace_calculated_at       = :la",
        ].join(", "),
        ExpressionAttributeValues: {
          ":ls": laceResult.totalScore,
          ":lr": laceResult.riskLevel,
          ":lc": laceResult.components,
          ":ld": laceResult.lengthOfStayDays,
          ":cs": laceResult.charlsonScore,
          ":li": laceResult.interpretation,
          ":la": calculatedAt,
        },
      })
    );
    console.log(
      `[LACE] Calculated from FHIR and stored in PatientProfiles: score=${laceResult.totalScore}`
    );
  }

  // STEP 4 — Load clinical rules (latest version from versioned ClinicalRules table)
  const rulesTable2 = process.env["DYNAMO_TABLE_RULES"] ?? "ClinicalRules";
  const ruleResults = await Promise.all(
    conditionCodes.map((code) => getLatestRule(code, dynamo, rulesTable2))
  );
  const rules = ruleResults.filter((r): r is NonNullable<typeof r> => r !== null);
  const rulesFound = rules.length > 0;

  // Extract version metadata from the first matched rule.
  // Cast via Record to avoid strict-mode errors on optional versioning fields.
  const primaryRuleRaw    = (rules[0] ?? null) as Record<string, unknown> | null;
  const ruleVersionId     = (primaryRuleRaw?.["version_id"]     as string | undefined) ?? null;
  const ruleVersion       = (primaryRuleRaw?.["version"]        as number | undefined) ?? null;
  const ruleEffectiveFrom = (primaryRuleRaw?.["effective_from"] as string | undefined) ?? null;

  // STEP 5 — Check FHIR completeness
  const fhirRecordComplete =
    patientRecord.patient.name.length > 0 &&
    !!patientRecord.patient.birthDate &&
    patientRecord.conditions.length > 0 &&
    patientRecord.medications.length > 0;

  // STEP 6 — Detect language
  let targetLanguage = "en";
  if (patientRecord.patient.communication) {
    for (const comm of patientRecord.patient.communication) {
      const code = comm.language.coding[0]?.code;
      if (code === "es") {
        targetLanguage = "es";
        break;
      }
    }
  }

  // STEP 7 — Build prompt
  const prompt = buildCarePlannerPrompt({
    patient: patientRecord,
    rules,
    targetLanguage,
    laceResult,
    ...(event.regeneration
      ? { regenerationContext: event.regeneration.rejectionReason }
      : {}),
  });

  // STEP 8 — Call Nova Pro
  const bedrockResult = await callNovaPro(prompt);

  // STEP 9 — Validate protocol (initialize with fallback)
  const makeFallback = (): TriageProtocol => ({
    patient_id: event.patientId,
    preferred_language: targetLanguage,
    flag_color:
      laceResult.riskLevel === "HIGH" || laceResult.riskLevel === "VERY HIGH"
        ? "RED"
        : "YELLOW",
    question_priority: [
      "medication_adherence",
      "appetite",
      "mobility",
      "dizziness",
    ],
    root_node: {
      logic: "OR",
      conditions: [
        {
          variable: "medication_adherence",
          operator: "==",
          threshold: false,
          weight: 0.8,
        },
        {
          variable: "appetite",
          operator: "==",
          threshold: false,
          weight: 0.6,
        },
        {
          variable: "mobility",
          operator: "==",
          threshold: false,
          weight: 0.5,
        },
        {
          variable: "dizziness",
          operator: "==",
          threshold: true,
          weight: 0.6,
        },
      ],
      weighted_threshold: 0.65,
    },
  });

  let protocol: TriageProtocol = makeFallback();
  let usedFallback = true;
  let zodValidationPassed = false;

  if (bedrockResult.parseSuccess) {
    const parseResult = TriageProtocol.safeParse(bedrockResult.parsedJson);
    if (parseResult.success) {
      protocol = parseResult.data;
      zodValidationPassed = true;
      usedFallback = false;
    } else {
      console.warn(
        "[care-planner] Zod validation failed:",
        parseResult.error.issues.length,
        "issues"
      );
    }
  } else {
    console.warn("[care-planner] JSON parse failed:", bedrockResult.parseError);
  }

  // STEP 10 — Score confidence
  const confidenceResult = scoreConfidence({
    conditionCode: conditionCodes[0] ?? "UNKNOWN",
    rulesFound,
    conditionCount: conditionCodes.length,
    fhirRecordComplete,
    zodValidationPassed,
    usedFallback,
    laceScore: laceResult.totalScore,
    laceRiskLevel: laceResult.riskLevel,
  });

  // STEP 11 — Determine status
  // Regenerated protocols ALWAYS go to PENDING_REVIEW regardless of confidence score,
  // so the nurse can verify their feedback was addressed.
  let status: "AUTO_APPROVED" | "PENDING_REVIEW";
  let auto_approval_reason: string | null;
  let pending_reason: string | null;

  if (event.regeneration) {
    status = "PENDING_REVIEW";
    auto_approval_reason = null;
    pending_reason = `↻ REVISED PROTOCOL — Regenerated protocol awaiting clinical verification. Previous rejection reason: "${event.regeneration.rejectionReason}". Please verify the feedback has been addressed.`;
  } else {
    status = confidenceResult.autoApprove ? "AUTO_APPROVED" : "PENDING_REVIEW";
    auto_approval_reason = confidenceResult.autoApprove
      ? confidenceResult.reasons.join(". ")
      : null;
    pending_reason = !confidenceResult.autoApprove
      ? confidenceResult.reasons.join(". ")
      : null;
  }

  // STEP 12 — Generate review ID (use REGEN suffix when regenerating)
  const reviewId = event.regeneration
    ? `REV-${event.patientId}-REGEN-${Date.now()}`
    : `REV-${event.patientId}-${Date.now()}`;

  // STEP 12b — Ensure flag_color is set on every condition (always runs)
  if (protocol.root_node?.conditions) {
    const clinicalRule = rules.length > 0 ? rules[0] : null;
    (protocol.root_node as Record<string, unknown>)["conditions"] =
      (protocol.root_node.conditions as Record<string, unknown>[]).map((condition) => {
        const c = condition as Record<string, unknown>;
        // Priority 1: matched clinical rule condition
        const matched = clinicalRule?.conditions.find(
          (r: { variable: string }) => r.variable === c["variable"]
        );
        if (matched?.flag_color) return { ...c, flag_color: matched.flag_color };
        // Priority 2: already set by Nova Pro (preserved through schema)
        if (c["flag_color"]) return c;
        // Priority 3: derive from weight — weight >= 0.80 = RED, else YELLOW
        const weight = typeof c["weight"] === "number" ? (c["weight"] as number) : 0;
        return { ...c, flag_color: weight >= 0.80 ? "RED" : "YELLOW" };
      });
    if (clinicalRule) {
      (protocol as Record<string, unknown>)["flag_color"] = clinicalRule.flag_color;
    }
  }

  // STEP 13 — Save to ProtocolReview
  const now = new Date().toISOString();

  // If regeneration, fetch previous regeneration_count to increment it
  let regenerationCount = 1;
  if (event.regeneration) {
    const prevRecord = await dynamo.send(
      new GetCommand({
        TableName: reviewsTable,
        Key: {
          review_id: event.regeneration.previousReviewId,
          patient_id: event.patientId,
        },
      })
    );
    const prevCount =
      typeof prevRecord.Item?.["regeneration_count"] === "number"
        ? (prevRecord.Item["regeneration_count"] as number)
        : 0;
    regenerationCount = prevCount + 1;
  }

  await dynamo.send(
    new PutCommand({
      TableName: reviewsTable,
      Item: {
        review_id: reviewId,
        patient_id: event.patientId,
        status,
        confidence_score: confidenceResult.score,
        auto_approval_reason,
        pending_reason,
        protocol,
        protocol_source: rulesFound ? "validated_library" : "ai_generated",
        condition_code: conditionCodes[0] ?? "UNKNOWN",
        ai_model_used:
          process.env["BEDROCK_MODEL_CARE_PLANNER"] ?? "amazon.nova-lite-v1:0",
        lace_score: laceResult.totalScore,
        lace_risk_level: laceResult.riskLevel,
        lace_interpretation: laceResult.interpretation,
        lace_components: laceResult.components,
        rule_version_id:    ruleVersionId,
        rule_version:       ruleVersion,
        rule_effective_from: ruleEffectiveFrom,
        rejection_reason: null,
        reviewed_by: status === "AUTO_APPROVED" ? "SYSTEM" : null,
        reviewed_at: status === "AUTO_APPROVED" ? now : null,
        review_notes: null,
        created_at: now,
        approved_at: status === "AUTO_APPROVED" ? now : null,
        ...(event.regeneration
          ? {
              is_regeneration: true,
              previous_review_id: event.regeneration.previousReviewId,
              regeneration_reason: event.regeneration.rejectionReason,
              regeneration_count: regenerationCount,
            }
          : {}),
      },
    })
  );

  auditLog({
    eventType: "PROTOCOL_GENERATED",
    patientId: event.patientId,
    performedBy: "CARE_PLANNER",
    action: `Protocol generated — status: ${status}`,
    timestamp: new Date().toISOString(),
    success: true,
  });

  // STEP 13b — If regeneration, update the old review to reference the new one
  if (event.regeneration) {
    await dynamo.send(
      new UpdateCommand({
        TableName: reviewsTable,
        Key: {
          review_id: event.regeneration.previousReviewId,
          patient_id: event.patientId,
        },
        UpdateExpression:
          "SET regenerated_as = :ra, regeneration_triggered_at = :rt",
        ExpressionAttributeValues: {
          ":ra": reviewId,
          ":rt": now,
        },
      })
    );

    auditLog({
      eventType: "PROTOCOL_GENERATED",
      patientId: event.patientId,
      performedBy: "CARE_PLANNER",
      action: `Protocol regenerated after rejection. Previous: ${event.regeneration.previousReviewId} New: ${reviewId}`,
      timestamp: new Date().toISOString(),
      success: true,
    });
  }

  // STEP 14 — If AUTO_APPROVED save to TriageProtocols
  if (status === "AUTO_APPROVED") {
    await dynamo.send(
      new PutCommand({
        TableName: protocolsTable,
        Item: {
          patient_id: event.patientId,
          protocol,
          lace_score: laceResult.totalScore,
          lace_risk_level: laceResult.riskLevel,
          rule_version_id:    ruleVersionId,
          rule_version:       ruleVersion,
          rule_effective_from: ruleEffectiveFrom,
          created_at: now,
          approved_by: "SYSTEM",
          review_id: reviewId,
        },
      })
    );
  }

  // STEP 15 — Generate Polly audio
  const audioMap: Record<string, string> = {};
  let audioSuccessCount = 0;

  for (const variable of protocol.question_priority) {
    const result = await generateQuestionAudio({
      patientId: event.patientId,
      questionVariable: variable,
      language: targetLanguage,
    });
    if (result.success) {
      audioMap[variable] = result.s3Key;
      audioSuccessCount++;
    }
  }

  // STEP 16 — Return response
  return {
    statusCode: 200,
    patientId: event.patientId,
    reviewId,
    status,
    confidenceScore: confidenceResult.score,
    autoApprovalReason: auto_approval_reason,
    pendingReason: pending_reason,
    conditionCodes,
    rulesFound,
    usedFallback,
    laceScore: laceResult.totalScore,
    laceRiskLevel: laceResult.riskLevel,
    audioGenerated: audioSuccessCount,
    audioMap,
    preferredLanguage: protocol.preferred_language,
    questionPriority: protocol.question_priority,
    ...(event.regeneration
      ? {
          isRegeneration: true,
          previousReviewId: event.regeneration.previousReviewId,
          newReviewId: reviewId,
        }
      : {}),
  };
};
