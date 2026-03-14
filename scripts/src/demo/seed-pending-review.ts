/**
 * seed-pending-review.ts — Seed a PENDING_REVIEW ProtocolReview record for P004.
 * Idempotent: always overwrites to reset the demo state.
 */
import * as dotenv from "dotenv";
import * as path from "path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function makeDynamo(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  });
  return DynamoDBDocumentClient.from(raw);
}

export async function seedPendingReview(): Promise<void> {
  const dynamo = makeDynamo();
  const reviewsTable = process.env["DYNAMO_TABLE_REVIEWS"] ?? "ProtocolReview";

  const record = {
    review_id: "REV-P004-DEMO",
    patient_id: "P004",
    status: "PENDING_REVIEW",
    confidence_score: 0.61,
    pending_reason:
      "Multiple comorbidities detected. Confidence below threshold (0.61 < 0.70). " +
      "Pneumonia patient with secondary cardiac history requires clinical validation " +
      "before call proceeds.",
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
    protocol: {
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
          {
            variable: "shortness_of_breath",
            operator: "==",
            threshold: true,
            weight: 0.9,
            flag_color: "RED",
          },
          {
            variable: "fever",
            operator: ">=",
            threshold: 101,
            weight: 0.8,
            flag_color: "RED",
          },
          {
            variable: "antibiotic_taken",
            operator: "==",
            threshold: false,
            weight: 0.7,
            flag_color: "RED",
          },
          {
            variable: "confusion",
            operator: "==",
            threshold: true,
            weight: 0.8,
            flag_color: "RED",
          },
          {
            variable: "appetite",
            operator: "==",
            threshold: false,
            weight: 0.5,
            flag_color: "YELLOW",
          },
          {
            variable: "mobility",
            operator: "==",
            threshold: false,
            weight: 0.4,
            flag_color: "YELLOW",
          },
        ],
      },
    },
  };

  await dynamo.send(
    new PutCommand({ TableName: reviewsTable, Item: record })
  );
  console.log("[PUT] ProtocolReview/REV-P004-DEMO — status: PENDING_REVIEW");

  // Verify
  const check = await dynamo.send(
    new GetCommand({
      TableName: reviewsTable,
      Key: { review_id: "REV-P004-DEMO", patient_id: "P004" },
    })
  );

  const status = check.Item?.["status"] as string | undefined;
  const confidence = check.Item?.["confidence_score"] as number | undefined;

  console.log("\n── Verification ──────────────────────────────────────");
  console.log(`  review_id:       ${check.Item?.["review_id"] ?? "NOT FOUND"}`);
  console.log(`  patient_id:      ${check.Item?.["patient_id"] ?? "NOT FOUND"}`);
  console.log(`  status:          ${status ?? "NOT FOUND"}`);
  console.log(`  confidence_score: ${confidence ?? "NOT FOUND"}`);
  console.log(
    `\nSeed: ${status === "PENDING_REVIEW" ? "PASS" : "FAIL"}`
  );

  if (status !== "PENDING_REVIEW") throw new Error(`REV-P004-DEMO status is "${status ?? "NOT FOUND"}" — expected PENDING_REVIEW`);
}

async function main(): Promise<void> { await seedPendingReview(); }

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("seed-pending-review failed:", err);
    process.exit(1);
  });
}
