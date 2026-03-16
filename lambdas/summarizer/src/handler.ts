import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { auditLog } from "@sentinel/audit";
import { validatePatientId, validateCallId } from "@sentinel/validation";
import { buildSbarPrompt } from "./sbar-prompt";

// ─── Natural language rule conversion ────────────────────────────────────────
// Converts raw rule strings (e.g. "weight_gain_lbs >= 3") to human-readable
// descriptions using only the rule's own variable name, operator, and threshold —
// no hardcoded variable-name lookup tables.

function convertRulesToNaturalLanguage(brokenRules: string[]): string[] {
  return brokenRules.map((rule) => {
    const match = rule.match(/^(\S+)\s*(>=|<=|>|<|==)\s*(.+)$/);
    if (!match) return rule;

    const [, varRaw, op, threshRaw] = match;
    const varName = varRaw.replace(/_/g, " ");
    const threshold = threshRaw.trim();

    if (threshold === "true")  return `${varName} is present`;
    if (threshold === "false") return `${varName} is absent`;

    const opText =
      op === ">=" ? "is at least" :
      op === ">"  ? "exceeds"     :
      op === "<=" ? "is at most"  :
      op === "<"  ? "is below"    :
      "is";

    return `${varName} ${opText} ${threshold}`;
  });
}

// ─── Clients ──────────────────────────────────────────────────────────────────

const dynamoEndpoint = process.env["DYNAMO_ENDPOINT"];
const dynamoBase = new DynamoDBClient({
  region: process.env["AWS_REGION"] ?? "us-east-1",
  ...(dynamoEndpoint ? { endpoint: dynamoEndpoint } : {}),
});
const dynamo = DynamoDBDocumentClient.from(dynamoBase);

const bedrockClient = new BedrockRuntimeClient({
  region: process.env["AWS_REGION"] ?? "us-east-1",
});

const snsClient = new SNSClient({
  region: process.env["AWS_REGION"] ?? "us-east-1",
});

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (event: {
  callId: string;
  patientId: string;
  // Optional triage data passed directly from lex-fulfillment (avoids race condition)
  triageStatus?: string;
  brokenRules?: string[];
  weightedScore?: number;
  laceScore?: number;
  laceRiskLevel?: string;
  variables?: Record<string, string>;
}): Promise<object> => {
  // STEP 1 — Validate input
  if (!validatePatientId(event.patientId)) {
    return { statusCode: 400, error: "Invalid patientId format" };
  }
  if (!validateCallId(event.callId)) {
    return { statusCode: 400, error: "Invalid callId format" };
  }

  // STEP 2 — Load CallResults record
  // If triage data was passed directly in the event, use it immediately (no DynamoDB poll needed).
  // Otherwise, poll up to 3 times with 2s delay waiting for triage_status to be written.
  const resultsTable = process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults";
  const eventHasTriage = typeof event.triageStatus === "string" && event.triageStatus !== "";

  let item: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 2_000));
      console.warn(`[summarizer] retrying DynamoDB read — attempt ${attempt + 1}/3`);
    }
    const getResult = await dynamo.send(
      new GetCommand({
        TableName: resultsTable,
        Key: { call_id: event.callId, patient_id: event.patientId },
      })
    );
    if (!getResult.Item) {
      return { statusCode: 404, error: "Call result not found" };
    }
    item = getResult.Item as Record<string, unknown>;
    // If triage data is in the event, one read is enough — no need to poll.
    if (eventHasTriage) break;
    const ts = item["triage_status"] as string | undefined;
    if (ts && ts !== "IN_PROGRESS") break;
    console.warn(`[summarizer] triage_status=${ts ?? "missing"} — waiting for triage result...`);
  }

  if (!item) {
    return { statusCode: 404, error: "Call result not found" };
  }

  // Prefer triage values from event (written by synchronous triage invocation in lex-fulfillment).
  const triageStatus  = event.triageStatus  ?? (item["triage_status"]   as string | undefined);
  const brokenRules   = event.brokenRules   ?? (item["broken_rules"]    as string[] | undefined) ?? [];
  const weightedScore = event.weightedScore ?? (item["weighted_score"]  as number | undefined) ?? 0;
  const laceScore     = event.laceScore     ?? (item["lace_score"]      as number | undefined) ?? 0;
  const laceRiskLevel = event.laceRiskLevel ?? (item["lace_risk_level"] as string | undefined) ?? "UNKNOWN";
  let conditionCode = (item["condition_code"] as string | undefined) ?? "UNKNOWN";
  const callTimestamp = (item["call_timestamp"] as string | undefined) ?? "";
  const callStatus    = (item["call_status"]    as string | undefined) ?? "UNKNOWN";

  if (!triageStatus || triageStatus === "IN_PROGRESS") {
    console.warn(`[summarizer] triage_status=${triageStatus ?? "missing"} after retries — proceeding as INCOMPLETE`);
  }

  // STEP 3 — Load FHIR patient data
  let medications: string[] = [];
  let dischargeDate = "unknown";
  let attendingPhysician = "unknown";
  let fhirConditionCode    = "";
  let fhirConditionDisplay = "";

  try {
    const { getFullPatientRecord } = await import(
      "../../../scripts/src/fhir/fhir-client"
    );
    const record = await getFullPatientRecord(event.patientId);

    medications = record.medications.map(
      (m) =>
        m.medicationCodeableConcept?.coding?.[0]?.display ?? "unknown medication"
    );

    const dischargeDateExt = record.patient.extension?.find(
      (e) => e.url === "discharge-date"
    );
    if (dischargeDateExt?.valueDate) {
      dischargeDate = dischargeDateExt.valueDate;
    } else if (record.encounterSummary.dischargeDate) {
      dischargeDate = record.encounterSummary.dischargeDate;
    }

    const physicianExt = record.patient.extension?.find(
      (e) => e.url === "attending-physician"
    );
    if (physicianExt?.valueString) {
      attendingPhysician = physicianExt.valueString;
    }

    // Extract condition from FHIR as fallback for when condition_code is missing/UNKNOWN
    const firstCond = record.conditions[0];
    if (firstCond) {
      fhirConditionCode    = firstCond.code.coding[0]?.code ?? "";
      fhirConditionDisplay = firstCond.code.coding[0]?.display ?? firstCond.code.text ?? fhirConditionCode;
    }
  } catch {
    // FHIR unavailable — proceed with defaults
  }

  // If condition_code was never written to CallResults, fall back to FHIR value
  if (!conditionCode || conditionCode === "UNKNOWN") {
    conditionCode = fhirConditionCode || "UNKNOWN";
  }

  // STEP 4 — Load clinical rules for broken rules
  let guidelineSource = "Clinical Guidelines";
  let guidelineUrl = "";
  let conditionDisplay = fhirConditionDisplay || conditionCode;
  let clinicalNotes: string[] = [];

  try {
    const { getRulesForCondition } = await import(
      "../../../scripts/src/rules/clinical-rules-client"
    );
    const rule = await getRulesForCondition(conditionCode);

    if (rule) {
      guidelineSource = rule.guideline_source;
      guidelineUrl = rule.guideline_url;
      conditionDisplay = rule.condition_display;

      clinicalNotes = brokenRules
        .map((brokenVar) => {
          const match = rule.conditions.find((c) => c.variable === brokenVar);
          return match?.clinical_note ?? null;
        })
        .filter((note): note is string => note !== null);
    }
  } catch {
    // Rules unavailable — proceed with defaults
  }

  // STEP 5 — Build SBAR prompt
  const laceInterpretation =
    laceScore > 0
      ? `LACE ${laceScore} — ${laceRiskLevel} readmission risk`
      : "LACE score not available";

  const validTriageStatuses = ["GREEN", "YELLOW", "RED", "INCOMPLETE"] as const;
  type TriageStatus = (typeof validTriageStatuses)[number];
  const typedTriageStatus: TriageStatus = validTriageStatuses.includes(
    triageStatus as TriageStatus
  )
    ? (triageStatus as TriageStatus)
    : "INCOMPLETE";

  const brokenRulesNatural = convertRulesToNaturalLanguage(brokenRules);

  const prompt = buildSbarPrompt({
    patientId: event.patientId,
    conditionCode,
    conditionDisplay,
    triageStatus: typedTriageStatus,
    brokenRules,
    brokenRulesNatural,
    weightedScore,
    laceScore,
    laceRiskLevel,
    laceInterpretation,
    guidelineSource,
    guidelineUrl,
    clinicalNotes,
    callTimestamp,
    medications,
    dischargeDate,
    attendingPhysician,
    callStatus,
  });

  // STEP 6 — Call Nova Lite
  let sbarText = "";
  let bedrockFailed = false;

  try {
    const modelId = process.env["BEDROCK_MODEL_SUMMARIZER"] ?? "amazon.nova-lite-v1:0";
    const requestBody = {
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 600, temperature: 0.2 },
    };

    const response = await bedrockClient.send(
      new InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(requestBody),
      })
    );

    const rawBody = Buffer.from(response.body).toString("utf-8");
    const parsed = JSON.parse(rawBody) as {
      output?: { message?: { content?: Array<{ text?: string }> } };
    };
    const rawText = parsed.output?.message?.content?.[0]?.text ?? "";
    sbarText = rawText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();

    // Normalize abbreviated section headers to full SBAR labels
    sbarText = sbarText
      .replace(/^S:\s*/gm, "S (Situation): ")
      .replace(/^B:\s*/gm, "B (Background): ")
      .replace(/^A:\s*/gm, "A (Assessment): ")
      .replace(/^R:\s*/gm, "R (Recommendation): ");
  } catch {
    bedrockFailed = true;
  }

  // Guard: if Nova Lite output contains bracket placeholders, it failed to substitute — regenerate once
  if (sbarText && /\[(?:ICD-10 code|condition name|guideline source)\]/i.test(sbarText)) {
    console.warn("[summarizer] SBAR contains placeholder brackets — regenerating once");
    sbarText = "";
    bedrockFailed = false;
    try {
      const modelId = process.env["BEDROCK_MODEL_SUMMARIZER"] ?? "amazon.nova-lite-v1:0";
      const retryBody = {
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 600, temperature: 0.1 },
      };
      const retryResp = await bedrockClient.send(
        new InvokeModelCommand({
          modelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify(retryBody),
        })
      );
      const retryRaw = Buffer.from(retryResp.body).toString("utf-8");
      const retryParsed = JSON.parse(retryRaw) as {
        output?: { message?: { content?: Array<{ text?: string }> } };
      };
      sbarText = (retryParsed.output?.message?.content?.[0]?.text ?? "")
        .replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim()
        .replace(/^S:\s*/gm, "S (Situation): ")
        .replace(/^B:\s*/gm, "B (Background): ")
        .replace(/^A:\s*/gm, "A (Assessment): ")
        .replace(/^R:\s*/gm, "R (Recommendation): ");
      if (/\[/.test(sbarText)) {
        console.error("[summarizer] Retry still has placeholders — using structured fallback");
        sbarText = "";
      }
    } catch {
      bedrockFailed = true;
    }
  }

  // Fallback SBAR if Bedrock failed or returned empty
  if (!sbarText) {
    bedrockFailed = true;
    sbarText = `S (Situation): Post-discharge follow-up call completed for patient ${event.patientId} with ${conditionCode} ${conditionDisplay}. Triage status: ${typedTriageStatus}.

B (Background): Patient discharged on ${dischargeDate}. Attending: ${attendingPhysician}.

A (Assessment): ${brokenRules.length} clinical threshold(s) exceeded: ${brokenRules.join(", ") || "none"}. Per ${guidelineSource}.

R (Recommendation): Nurse review required. Contact patient for follow-up.`;
  }

  // STEP 7 — Update CallResults with SBAR
  await dynamo.send(
    new UpdateCommand({
      TableName: resultsTable,
      Key: { call_id: event.callId, patient_id: event.patientId },
      UpdateExpression:
        "SET sbar_summary = :ss, sbar_generated_at = :sg, guideline_source = :gs",
      ExpressionAttributeValues: {
        ":ss": sbarText,
        ":sg": new Date().toISOString(),
        ":gs": guidelineSource,
      },
    })
  );

  auditLog({
    eventType: "SBAR_GENERATED",
    patientId: event.patientId,
    callId: event.callId,
    performedBy: "SUMMARIZER",
    action: "SBAR summary generated and saved",
    timestamp: new Date().toISOString(),
    success: true,
  });

  // STEP 8 — SNS alert if RED
  if (typedTriageStatus === "RED") {
    try {
      const topicArn = process.env["ESCALATION_TOPIC_ARN"];
      if (topicArn) {
        await snsClient.send(
          new PublishCommand({
            TopicArn: topicArn,
            Subject: `URGENT RED Alert — Patient ${event.patientId}`,
            Message: JSON.stringify({
              patientId: event.patientId,
              callId: event.callId,
              triageStatus: "RED",
              sbarSummary: sbarText,
              brokenRules,
              laceScore,
              laceRiskLevel,
              guidelineSource,
              callTimestamp: new Date().toISOString(),
              action: "NURSE CALLBACK REQUIRED IMMEDIATELY",
            }),
          })
        );
      }
    } catch (snsErr) {
      console.error("SNS publish failed (non-fatal):", snsErr);
    }
  }

  // STEP 9 — Return response
  return {
    statusCode: 200,
    callId: event.callId,
    patientId: event.patientId,
    triageStatus: typedTriageStatus,
    sbarGenerated: true,
    sbarLength: sbarText.length,
    guidelineSource,
    escalationTriggered: typedTriageStatus === "RED",
    usedFallback: bedrockFailed,
  };
};
