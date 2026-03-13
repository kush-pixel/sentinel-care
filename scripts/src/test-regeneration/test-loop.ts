/**
 * test-loop.ts — Full rejection → regeneration loop test.
 *
 * STEP 1: Seed a fresh PENDING_REVIEW record (REV-REGEN-TEST / P004)
 * STEP 2: Call care planner handler with regeneration context
 * STEP 3: Verify new record is PENDING_REVIEW with is_regeneration: true
 *         and old record has regenerated_as set
 */
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { handler as carePlannerHandler } from "../../../lambdas/care-planner/src/handler";

function makeDynamo(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  });
  return DynamoDBDocumentClient.from(raw);
}

const REVIEWS_TABLE = process.env["DYNAMO_TABLE_REVIEWS"] ?? "ProtocolReview";

const SEED_PROTOCOL = {
  patient_id: "P004",
  preferred_language: "en",
  flag_color: "RED",
  question_priority: [
    "shortness_of_breath",
    "fever",
    "antibiotic_taken",
    "confusion",
    "appetite",
    "mobility",
  ],
  root_node: {
    logic: "OR",
    weighted_threshold: 0.65,
    conditions: [
      { variable: "shortness_of_breath", operator: "==", threshold: true,  weight: 0.9, flag_color: "RED" },
      { variable: "fever",               operator: ">=", threshold: 101,   weight: 0.8, flag_color: "RED" },
      { variable: "antibiotic_taken",    operator: "==", threshold: false, weight: 0.7, flag_color: "RED" },
      { variable: "confusion",           operator: "==", threshold: true,  weight: 0.8, flag_color: "RED" },
      { variable: "appetite",            operator: "==", threshold: false, weight: 0.5, flag_color: "YELLOW" },
      { variable: "mobility",            operator: "==", threshold: false, weight: 0.4, flag_color: "YELLOW" },
    ],
  },
};

async function main(): Promise<void> {
  console.log("══════════════════════════════════════════════════════");
  console.log("REGENERATION LOOP TEST — P004 / REV-REGEN-TEST");
  console.log("══════════════════════════════════════════════════════\n");

  const dynamo = makeDynamo();

  // ─── STEP 1: Seed fresh PENDING_REVIEW record ──────────────────────────────
  console.log("STEP 1 — Seeding REV-REGEN-TEST...");
  await dynamo.send(
    new PutCommand({
      TableName: REVIEWS_TABLE,
      Item: {
        review_id: "REV-REGEN-TEST",
        patient_id: "P004",
        status: "PENDING_REVIEW",
        confidence_score: 0.61,
        pending_reason: "Multiple comorbidities detected. Confidence below threshold (0.61 < 0.70). Pneumonia patient with secondary cardiac history requires clinical validation before call proceeds.",
        auto_approval_reason: null,
        protocol_source: "validated_library",
        condition_code: "J18.9",
        lace_score: 9,
        lace_risk_level: "MODERATE",
        lace_components: { L: 3, A: 3, C: 0, E: 3 },
        ai_model_used: "amazon.nova-lite-v1:0",
        rejection_reason: null,
        reviewed_by: null,
        reviewed_at: null,
        review_notes: null,
        created_at: new Date().toISOString(),
        approved_at: null,
        protocol: SEED_PROTOCOL,
      },
    })
  );
  console.log("  [PUT] REV-REGEN-TEST → PENDING_REVIEW\n");

  // ─── STEP 2: Simulate rejection by calling care planner with regeneration ──
  console.log("STEP 2 — Calling care planner with regeneration context...");

  const result = (await carePlannerHandler({
    patientId: "P004",
    regeneration: {
      previousReviewId: "REV-REGEN-TEST",
      rejectionReason:
        "Protocol missing oxygen saturation monitoring. Patient has secondary cardiac history — SpO2 below 94% requires immediate escalation.",
      rejectedAt: new Date().toISOString(),
      reviewedBy: "TestNurse",
    },
  })) as Record<string, unknown>;

  console.log("\n─── Regeneration Handler Response ───────────────────");
  console.log(`  statusCode:       ${result["statusCode"]}`);
  console.log(`  isRegeneration:   ${result["isRegeneration"]}`);
  console.log(`  previousReviewId: ${result["previousReviewId"]}`);
  console.log(`  newReviewId:      ${result["newReviewId"]}`);
  console.log(`  status:           ${result["status"]}`);

  const newReviewId = result["newReviewId"] as string | undefined;

  // ─── STEP 3: Verify new and old records ───────────────────────────────────
  console.log("\nSTEP 3 — Verifying DynamoDB records...");

  const [newRecord, oldRecord] = await Promise.all([
    newReviewId
      ? dynamo.send(
          new GetCommand({
            TableName: REVIEWS_TABLE,
            Key: { review_id: newReviewId, patient_id: "P004" },
          })
        )
      : Promise.resolve({ Item: undefined }),
    dynamo.send(
      new GetCommand({
        TableName: REVIEWS_TABLE,
        Key: { review_id: "REV-REGEN-TEST", patient_id: "P004" },
      })
    ),
  ]);

  const newItem = newRecord.Item as Record<string, unknown> | undefined;
  const oldItem = oldRecord.Item as Record<string, unknown> | undefined;

  console.log("\n─── New Record ──────────────────────────────────────");
  console.log(`  review_id:          ${newItem?.["review_id"] ?? "NOT FOUND"}`);
  console.log(`  status:             ${newItem?.["status"] ?? "NOT FOUND"}`);
  console.log(`  is_regeneration:    ${newItem?.["is_regeneration"] ?? "NOT FOUND"}`);
  console.log(`  previous_review_id: ${newItem?.["previous_review_id"] ?? "NOT FOUND"}`);
  console.log(`  regeneration_count: ${newItem?.["regeneration_count"] ?? "NOT FOUND"}`);

  console.log("\n─── Old Record ──────────────────────────────────────");
  console.log(`  review_id:                  ${oldItem?.["review_id"] ?? "NOT FOUND"}`);
  console.log(`  status:                     ${oldItem?.["status"] ?? "NOT FOUND"}`);
  console.log(`  regenerated_as:             ${oldItem?.["regenerated_as"] ?? "NOT SET"}`);
  console.log(`  regeneration_triggered_at:  ${oldItem?.["regeneration_triggered_at"] ?? "NOT SET"}`);

  // ─── Verification ─────────────────────────────────────────────────────────
  const validStatuses = ["PENDING_REVIEW", "AUTO_APPROVED", "APPROVED"];
  const checks = {
    "statusCode == 200":                    result["statusCode"] === 200,
    "isRegeneration == true":               result["isRegeneration"] === true,
    "previousReviewId == REV-REGEN-TEST":   result["previousReviewId"] === "REV-REGEN-TEST",
    "newReviewId is set":                   typeof newReviewId === "string" && newReviewId.length > 0,
    "new record exists in DynamoDB":        newItem !== undefined,
    "new record has valid status":          validStatuses.includes(String(newItem?.["status"] ?? "")),
    "new record is_regeneration == true":   newItem?.["is_regeneration"] === true,
    "new record previous_review_id correct": newItem?.["previous_review_id"] === "REV-REGEN-TEST",
    "new record regeneration_count == 1":   newItem?.["regeneration_count"] === 1,
    "old record regenerated_as set":        typeof oldItem?.["regenerated_as"] === "string",
  };

  console.log("\n── Verification ──────────────────────────────────────");
  let allPass = true;
  for (const [label, pass] of Object.entries(checks)) {
    console.log(`  ${pass ? "PASS" : "FAIL"} — ${label}`);
    if (!pass) allPass = false;
  }

  console.log(`\nREGENERATION LOOP TEST: ${allPass ? "PASS" : "FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("test-loop failed:", err);
  process.exit(1);
});
