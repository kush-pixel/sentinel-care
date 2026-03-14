import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import type { TriageProtocol, PatientAnswers } from "@sentinel/schemas";
import { auditLog, auditEscalation } from "@sentinel/audit";
import { validatePatientId, validateCallId, getLatestRule, getRuleVersion } from "@sentinel/validation";
import { getLaceForPatient } from "@sentinel/lace";
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

  // STEP 2b — Read LACE from PatientProfiles (primary source of truth).
  // Falls back to TriageProtocols values if not yet hydrated.
  const storedLace = await getLaceForPatient(
    event.patientId,
    docClient,
    process.env["DYNAMO_TABLE_PATIENTS"] ?? "PatientProfiles"
  );

  const laceScore      = storedLace?.totalScore
    ?? (protocolResponse.Item["lace_score"]      as number | undefined);
  const laceRiskLevel  = storedLace?.riskLevel
    ?? (protocolResponse.Item["lace_risk_level"] as string | undefined);
  const laceComponents = storedLace?.components
    ?? (protocolResponse.Item["lace_components"] as { L: number; A: number; C: number; E: number } | undefined);

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

  // STEP 3b — Enforce flag_color from ClinicalRules using the exact rule version
  // stored in the protocol (so existing protocols are always evaluated against the
  // rule they were generated with, not whatever the latest version happens to be).
  const conditionCode   = callResponse.Item["condition_code"]  as string | undefined;
  const storedVersionId = protocolResponse.Item["rule_version_id"] as string | undefined;
  const rulesTableName  = process.env["DYNAMO_TABLE_RULES"] ?? "ClinicalRules";

  if (conditionCode) {
    let clinicalRule: Record<string, unknown> | null = null;

    if (storedVersionId) {
      // Load the exact version this protocol was generated with
      const versioned = await getRuleVersion(conditionCode, storedVersionId, docClient, rulesTableName);
      clinicalRule = versioned as Record<string, unknown> | null;
    } else {
      // Legacy protocol with no rule_version_id — fall back to latest
      console.warn(
        `[VERSION] Protocol for ${event.patientId} has no rule_version_id — using latest rule version`
      );
      const latest = await getLatestRule(conditionCode, docClient, rulesTableName);
      clinicalRule = latest as Record<string, unknown> | null;
    }

    if (clinicalRule?.["conditions"] && protocol.root_node?.conditions) {
      const ruleConditions = clinicalRule["conditions"] as Record<string, unknown>[];
      (protocol.root_node as Record<string, unknown>)["conditions"] =
        (protocol.root_node.conditions as Record<string, unknown>[]).map((condition) => {
          if (condition["flag_color"]) return condition;
          const matched = ruleConditions.find((c) => c["variable"] === condition["variable"]);
          return { ...condition, flag_color: matched?.["flag_color"] ?? "YELLOW" };
        });
    }
    if (clinicalRule?.["flag_color"]) {
      (protocol as Record<string, unknown>)["flag_color"] = clinicalRule["flag_color"];
    }

    // Write rule provenance + guideline source to CallResults for dashboard display
    const guideline = clinicalRule?.["guideline_source"] as string | undefined;
    const ruleVer   = clinicalRule?.["version"]          as number | undefined;
    const ruleVerId = clinicalRule?.["version_id"]       as string | undefined;
    const ruleEff   = clinicalRule?.["effective_from"]   as string | undefined;
    if (guideline || ruleVerId) {
      await docClient.send(
        new UpdateCommand({
          TableName: process.env["DYNAMO_TABLE_RESULTS"],
          Key: { call_id: event.callId, patient_id: event.patientId },
          UpdateExpression: [
            "SET guideline_source   = :gs",
            "    rule_version_id    = :rv",
            "    rule_version       = :rn",
            "    rule_effective_from = :re",
          ].join(", "),
          ExpressionAttributeValues: {
            ":gs": guideline    ?? null,
            ":rv": ruleVerId    ?? null,
            ":rn": ruleVer      ?? null,
            ":re": ruleEff      ?? null,
          },
        })
      );
    }
  }

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
        "    lace_components      = :lc",
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
        ":lc": laceComponents ?? null,
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
