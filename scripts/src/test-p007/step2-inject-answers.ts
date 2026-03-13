/**
 * step2-inject-answers.ts — Write RED-triggering COPD answers for C007/P007.
 *
 * Injected answers (with confidence > 0.7 so evaluator accepts them):
 *   shortness_of_breath: true  (0.92)  → triggers rule weight 0.9 > threshold 0.65
 *   rescue_inhaler_use:  4     (0.88)  → triggers rule weight 0.8 (4 >= 3)
 *   steroid_taken:       false (0.91)  → triggers rule weight 0.75
 *   sputum_colour:       true  (0.85)  → triggers rule weight 0.70
 *   medication_adherence: true (0.90)  → does NOT trigger (condition is == false)
 *
 * Expected triage: RED (shortness_of_breath alone exceeds weighted_threshold 0.65)
 */
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

function makeDynamo(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  });
  return DynamoDBDocumentClient.from(raw);
}

async function main(): Promise<void> {
  console.log("══════════════════════════════════════════════════════");
  console.log("STEP 2 — Inject RED-triggering answers for C007/P007");
  console.log("══════════════════════════════════════════════════════\n");

  const dynamo = makeDynamo();
  const resultsTable = process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults";

  const callRecord = {
    call_id: "C007",
    patient_id: "P007",
    call_status: "COMPLETE",
    call_timestamp: new Date().toISOString(),
    condition_code: "J44.1",
    unresolved_variables: [] as string[],
    transcript_warnings: [] as Array<{ section: string; warning: string }>,
    variables: {
      shortness_of_breath: { value: true,  confidence: 0.92 },
      rescue_inhaler_use:  { value: 4,     confidence: 0.88 },
      steroid_taken:       { value: false,  confidence: 0.91 },
      sputum_colour:       { value: true,   confidence: 0.85 },
      medication_adherence:{ value: true,   confidence: 0.90 },
    },
    // triage fields populated by step3
    triage_status: "IN_PROGRESS",
    broken_rules: [] as string[],
    weighted_score: null,
    escalation_triggered: false,
    skipped_variables: [] as string[],
    unresolved_variables_triage: [] as string[],
    incomplete_reason: null,
    lace_score: 9,
    lace_risk_level: "MODERATE",
    nurse_acknowledged: false,
  };

  await dynamo.send(
    new PutCommand({
      TableName: resultsTable,
      Item: callRecord,
    })
  );

  console.log("Written to CallResults:");
  console.log("  call_id:    C007");
  console.log("  patient_id: P007");
  console.log("  call_status: COMPLETE");
  console.log("  variables:");
  console.log("    shortness_of_breath: true  (conf 0.92)");
  console.log("    rescue_inhaler_use:  4      (conf 0.88)");
  console.log("    steroid_taken:       false  (conf 0.91)");
  console.log("    sputum_colour:       true   (conf 0.85)");
  console.log("    medication_adherence: true  (conf 0.90)");

  // Verify
  const check = await dynamo.send(
    new GetCommand({
      TableName: resultsTable,
      Key: { call_id: "C007", patient_id: "P007" },
    })
  );

  const exists = !!check.Item;
  const hasVars =
    check.Item?.["variables"] !== undefined &&
    (check.Item["variables"] as Record<string, unknown>)["shortness_of_breath"] !== undefined;

  console.log("\n── Verification ──────────────────────────────────────");
  console.log(`  CallResults C007/P007 exists: ${exists ? "PASS" : "FAIL"}`);
  console.log(`  variables.shortness_of_breath present: ${hasVars ? "PASS" : "FAIL"}`);
  console.log(`\nStep 2: ${exists && hasVars ? "PASS" : "FAIL"}`);

  if (!exists || !hasVars) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("step2-inject-answers failed:", err);
  process.exit(1);
});
