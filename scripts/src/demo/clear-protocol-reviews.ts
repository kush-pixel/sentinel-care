/**
 * clear-protocol-reviews.ts — Delete all records from the ProtocolReview table.
 * Uses scan + delete loop — does NOT drop/recreate the table.
 */
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

function makeDynamo(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  });
  return DynamoDBDocumentClient.from(raw);
}

export async function clearProtocolReviews(): Promise<void> {
  const dynamo = makeDynamo();
  const table = process.env["DYNAMO_TABLE_REVIEWS"] ?? "ProtocolReview";

  console.log(`Scanning ${table}...`);

  // Scan all items (paginate if needed)
  let lastKey: Record<string, unknown> | undefined;
  let totalDeleted = 0;

  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: "review_id, patient_id",
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      })
    );

    const items = result.Items ?? [];
    console.log(`  Found ${items.length} records in this page`);

    for (const item of items) {
      const reviewId = item["review_id"] as string;
      const patientId = item["patient_id"] as string;
      await dynamo.send(
        new DeleteCommand({
          TableName: table,
          Key: { review_id: reviewId, patient_id: patientId },
        })
      );
      console.log(`  [DELETE] ${reviewId} / ${patientId}`);
      totalDeleted++;
    }

    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  console.log(`\nDeleted ${totalDeleted} record(s) from ${table}.`);

  // Verify table is empty
  const verify = await dynamo.send(
    new ScanCommand({ TableName: table, Select: "COUNT" })
  );
  const remaining = verify.Count ?? 0;
  console.log(`Remaining records: ${remaining}`);
  console.log(`clear:reviews: ${remaining === 0 ? "PASS" : "FAIL — table not empty"}`);
  if (remaining !== 0) throw new Error(`Table not empty: ${remaining} record(s) remain`);
}

async function main(): Promise<void> {
  await clearProtocolReviews();
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("clear-protocol-reviews failed:", err);
    process.exit(1);
  });
}
