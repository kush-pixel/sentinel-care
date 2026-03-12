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
import { buildSbarPrompt } from "./sbar-prompt";

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
}): Promise<object> => {
  // STEP 1 — Validate input
  if (!event.callId || !event.patientId) {
    return { statusCode: 400, error: "callId and patientId required" };
  }

  // STEP 2 — Load CallResults record
  const resultsTable = process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults";
  const getResult = await dynamo.send(
    new GetCommand({
      TableName: resultsTable,
      Key: { call_id: event.callId, patient_id: event.patientId },
    })
  );

  if (!getResult.Item) {
    return { statusCode: 404, error: "Call result not found" };
  }

  const item = getResult.Item as Record<string, unknown>;
  const triageStatus = item["triage_status"] as string | undefined;
  const brokenRules = (item["broken_rules"] as string[] | undefined) ?? [];
  const weightedScore = (item["weighted_score"] as number | undefined) ?? 0;
  const laceScore = (item["lace_score"] as number | undefined) ?? 0;
  const laceRiskLevel = (item["lace_risk_level"] as string | undefined) ?? "UNKNOWN";
  const conditionCode = (item["condition_code"] as string | undefined) ?? "UNKNOWN";
  const callTimestamp = (item["call_timestamp"] as string | undefined) ?? "";

  if (!triageStatus || triageStatus === "IN_PROGRESS") {
    return {
      statusCode: 409,
      error: "Triage not yet complete — cannot generate SBAR",
    };
  }

  // STEP 3 — Load FHIR patient data
  let medications: string[] = [];
  let dischargeDate = "unknown";
  let attendingPhysician = "unknown";

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
  } catch {
    // FHIR unavailable — proceed with defaults
  }

  // STEP 4 — Load clinical rules for broken rules
  let guidelineSource = "Clinical Guidelines";
  let guidelineUrl = "";
  let conditionDisplay = conditionCode;
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

  const prompt = buildSbarPrompt({
    patientId: event.patientId,
    conditionCode,
    conditionDisplay,
    triageStatus: typedTriageStatus,
    brokenRules,
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

  // Fallback SBAR if Bedrock failed or returned empty
  if (!sbarText) {
    bedrockFailed = true;
    sbarText = `S (Situation): Post-discharge follow-up call completed for patient ${event.patientId}. Triage status: ${typedTriageStatus}.

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
