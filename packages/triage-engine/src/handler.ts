import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import type { TriageProtocol, PatientAnswers } from "@sentinel/schemas";
import { auditLog, auditEscalation } from "@sentinel/audit";
import { validatePatientId, validateCallId } from "@sentinel/validation";
import { evaluateProtocol } from "./evaluator";

// ─── AWS clients ──────────────────────────────────────────────────────────────

const dynamoClient = new DynamoDBClient({
  region: process.env["AWS_REGION"] ?? "us-east-1",
  ...(process.env["DYNAMO_ENDPOINT"]
    ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
    : {}),
});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const snsClient = new SNSClient({ region: process.env["AWS_REGION"] ?? "us-east-1" });

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (
  event: { callId: string; patientId: string }
): Promise<object> => {

  // STEP 1 — Validate input
  if (!validatePatientId(event.patientId)) {
    return { statusCode: 400, error: "Invalid patientId format" };
  }
  if (!validateCallId(event.callId)) {
    return { statusCode: 400, error: "Invalid callId format" };
  }

  // STEP 2 — Load protocol from TriageProtocols
  const protocolResponse = await docClient.send(
    new GetCommand({
      TableName: process.env["DYNAMO_TABLE_PROTOCOLS"],
      Key: { patient_id: event.patientId },
    })
  );

  if (!protocolResponse.Item) {
    return { statusCode: 404, error: "Protocol not found for patient" };
  }

  const protocol = protocolResponse.Item["protocol"] as TriageProtocol;
  const laceScore      = protocolResponse.Item["lace_score"]      as number | undefined;
  const laceRiskLevel  = protocolResponse.Item["lace_risk_level"] as string | undefined;

  // STEP 3 — Load PatientAnswers from CallResults
  const callResponse = await docClient.send(
    new GetCommand({
      TableName: process.env["DYNAMO_TABLE_RESULTS"],
      Key: {
        call_id:    event.callId,
        patient_id: event.patientId,
      },
    })
  );

  if (!callResponse.Item) {
    return { statusCode: 404, error: "Call result not found" };
  }

  const answers = callResponse.Item as unknown as PatientAnswers;

  // STEP 4 — Run triage engine
  const triageResult = evaluateProtocol(protocol, answers, laceRiskLevel);

  // Derive skipped variable names for audit trail
  const skippedVariables = triageResult.nodeResult.conditionResults
    .filter((r) => r.actualValue === undefined)
    .map((r) => r.variable);

  auditLog({
    eventType: "TRIAGE_COMPLETE",
    patientId: event.patientId,
    callId: event.callId,
    performedBy: "TRIAGE_ENGINE",
    action: `Triage completed — status: ${triageResult.flagColor}`,
    timestamp: new Date().toISOString(),
    success: true,
  });

  const isRed = triageResult.flagColor === "RED";

  // STEP 5 — Update CallResults with triage outcome
  await docClient.send(
    new UpdateCommand({
      TableName: process.env["DYNAMO_TABLE_RESULTS"],
      Key: {
        call_id:    event.callId,
        patient_id: event.patientId,
      },
      UpdateExpression: [
        "SET triage_status        = :ts",
        "    broken_rules         = :br",
        "    weighted_score       = :ws",
        "    escalation_triggered = :et",
        "    skipped_variables    = :sv",
        "    unresolved_variables = :uv",
        "    incomplete_reason    = :ir",
        "    lace_score           = :ls",
        "    lace_risk_level      = :lr",
        "    triage_completed_at  = :tc",
        "    nurse_acknowledged   = :na",
      ].join(", "),
      ExpressionAttributeValues: {
        ":ts": triageResult.flagColor,
        ":br": triageResult.brokenRules,
        ":ws": triageResult.weightedScore ?? null,
        ":et": isRed,
        ":sv": skippedVariables,
        ":uv": answers.unresolved_variables,
        ":ir": triageResult.incompleteReason ?? null,
        ":ls": laceScore ?? 0,
        ":lr": laceRiskLevel ?? "UNKNOWN",
        ":tc": new Date().toISOString(),
        ":na": false,
      },
    })
  );

  // STEP 6 — SNS alert if RED (failure must never crash the engine)
  try {
    if (isRed) {
      await snsClient.send(
        new PublishCommand({
          TopicArn: process.env["ESCALATION_TOPIC_ARN"],
          Subject:  `URGENT RED Alert — Patient ${event.patientId}`,
          Message: JSON.stringify({
            patientId:      event.patientId,
            callId:         event.callId,
            triageStatus:   "RED",
            brokenRules:    triageResult.brokenRules,
            weightedScore:  triageResult.weightedScore,
            laceScore:      laceScore ?? 0,
            laceRiskLevel:  laceRiskLevel ?? "UNKNOWN",
            callTimestamp:  new Date().toISOString(),
            action:         "NURSE CALLBACK REQUIRED IMMEDIATELY",
          }),
        })
      );
      auditEscalation(event.patientId, event.callId, true);
    }
  } catch (error: unknown) {
    console.error("SNS publish failed — triage still saved:", error);
    auditEscalation(event.patientId, event.callId, false);
  }

  // STEP 7 — Return response
  return {
    statusCode:          200,
    callId:              event.callId,
    patientId:           event.patientId,
    triageStatus:        triageResult.flagColor,
    brokenRules:         triageResult.brokenRules,
    weightedScore:       triageResult.weightedScore,
    skippedVariables,
    laceScore:           laceScore ?? 0,
    laceRiskLevel:       laceRiskLevel ?? "UNKNOWN",
    escalationTriggered: isRed,
    incompleteReason:    triageResult.incompleteReason,
  };
};
