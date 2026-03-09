import * as dotenv from "dotenv";
import * as path from "path";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { type ProtocolReview } from "@sentinel/schemas";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function makeClient(): DynamoDBClient {
  return new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  });
}

function table(): string {
  return process.env["DYNAMO_TABLE_REVIEWS"] ?? "ProtocolReview";
}

// ─── Reviews ──────────────────────────────────────────────────────────────────

const reviews: ProtocolReview[] = [
  {
    review_id: "REV001",
    patient_id: "P001",
    status: "AUTO_APPROVED",
    confidence_score: 0.94,
    auto_approval_reason:
      "All thresholds sourced from validated library. Condition I50.9 in supported list. AI confidence 0.94. Single primary condition. Zod validation passed with zero warnings.",
    pending_reason: null,
    protocol: {
      patient_id: "P001",
      preferred_language: "en",
      flag_color: "RED",
      question_priority: [
        "weight_gain_lbs",
        "shortness_of_breath",
        "lasix_filled",
        "ankle_swelling",
      ],
      root_node: {
        logic: "OR",
        conditions: [
          { variable: "weight_gain_lbs", operator: ">=", threshold: 3, weight: 0.9 },
          {
            variable: "shortness_of_breath",
            operator: "==",
            threshold: true,
            weight: 0.85,
          },
          { variable: "lasix_filled", operator: "==", threshold: false, weight: 0.8 },
        ],
        weighted_threshold: 0.75,
      },
    },
    protocol_source: "validated_library",
    condition_code: "I50.9",
    ai_model_used: "amazon.nova-lite-v1:0",
    rejection_reason: null,
    reviewed_by: "SYSTEM",
    reviewed_at: "2026-03-08T10:00:01Z",
    review_notes: null,
    created_at: "2026-03-08T10:00:00Z",
    approved_at: "2026-03-08T10:00:01Z",
  },
  {
    review_id: "REV002",
    patient_id: "P004",
    status: "PENDING_REVIEW",
    confidence_score: 0.71,
    auto_approval_reason: null,
    pending_reason:
      "Patient has multiple comorbidities. Condition J18.9 conflicts with secondary E11.9 on fever threshold. Manual review required to confirm protocol priority.",
    protocol: {
      patient_id: "P004",
      preferred_language: "en",
      flag_color: "RED",
      question_priority: [
        "shortness_of_breath",
        "fever",
        "antibiotic_taken",
        "confusion",
      ],
      root_node: {
        logic: "OR",
        conditions: [
          {
            variable: "shortness_of_breath",
            operator: "==",
            threshold: true,
            weight: 0.9,
          },
          { variable: "fever", operator: ">=", threshold: 101, weight: 0.85 },
          {
            variable: "antibiotic_taken",
            operator: "==",
            threshold: false,
            weight: 0.9,
          },
          { variable: "confusion", operator: "==", threshold: true, weight: 0.95 },
        ],
        weighted_threshold: 0.8,
      },
    },
    protocol_source: "validated_library",
    condition_code: "J18.9",
    ai_model_used: "amazon.nova-lite-v1:0",
    rejection_reason: null,
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
    created_at: "2026-03-08T10:15:00Z",
    approved_at: null,
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const client = makeClient();

  console.log("Seeding protocol reviews (idempotent)...\n");

  for (const review of reviews) {
    await client.send(
      new PutItemCommand({
        TableName: table(),
        Item: marshall(review, { removeUndefinedValues: true }),
      })
    );
    console.log(`[PUT] ${review.review_id} | ${review.patient_id} | ${review.status}`);
  }

  console.log("\nAll 2 protocol reviews written.");
}

main().catch((err: unknown) => {
  console.error("seed-pending-reviews failed:", err);
  process.exit(1);
});
