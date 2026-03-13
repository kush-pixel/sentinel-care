import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { TriageProtocol } from "@sentinel/schemas";
import { calculateLaceScore } from "@sentinel/lace";
import {
  getFullPatientRecord,
  getPatientEncounterSummary,
  FhirNotFoundError,
} from "../../../scripts/src/fhir/fhir-client";
import { getRulesForPatient } from "../../../scripts/src/rules/clinical-rules-client";
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

  // STEP 3 — Calculate LACE score
  const dischargeDateExt = patientRecord.patient.extension?.find(
    (e) => e.url === "discharge-date"
  )?.valueDate ?? new Date().toISOString().slice(0, 10);

  const encounterSummary = await getPatientEncounterSummary(
    event.patientId,
    dischargeDateExt
  );

  const conditionCodes = patientRecord.conditions
    .flatMap((c) => c.code.coding)
    .map((coding) => coding.code)
    .filter((code): code is string => !!code);

  const laceResult = calculateLaceScore({
    admissionDate: encounterSummary.admissionDate,
    dischargeDate: encounterSummary.dischargeDate,
    admissionType: encounterSummary.admissionType,
    conditionCodes,
    recentEDVisits: encounterSummary.recentEDVisits,
  });

  // STEP 4 — Load clinical rules
  const rules = await getRulesForPatient(conditionCodes);
  const rulesFound = rules.length > 0;

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
      console.log(
        "Zod validation failed:",
        parseResult.error.issues.length,
        "issues"
      );
    }
  } else {
    console.log("JSON parse failed:", bedrockResult.parseError);
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
  const status = confidenceResult.autoApprove ? "AUTO_APPROVED" : "PENDING_REVIEW";
  const auto_approval_reason = confidenceResult.autoApprove
    ? confidenceResult.reasons.join(". ")
    : null;
  const pending_reason = !confidenceResult.autoApprove
    ? confidenceResult.reasons.join(". ")
    : null;

  // STEP 12 — Generate review ID (use REGEN suffix when regenerating)
  const reviewId = event.regeneration
    ? `REV-${event.patientId}-REGEN-${Date.now()}`
    : `REV-${event.patientId}-${Date.now()}`;

  // STEP 13 — Save to ProtocolReview
  const dynamo = makeDynamo();
  const protocolsTable = process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols";
  const reviewsTable = process.env["DYNAMO_TABLE_REVIEWS"] ?? "ProtocolReview";
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
