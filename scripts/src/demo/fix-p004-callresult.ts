/**
 * fix-p004-callresult.ts — Delete stale C004/P004 record from CallResults.
 * P004's protocol is PENDING_REVIEW; no call result should exist.
 */
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

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
  const dynamo = makeDynamo();
  const table = process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults";

  console.log(`Deleting C004/P004 from ${table}...`);

  await dynamo.send(
    new DeleteCommand({
      TableName: table,
      Key: { call_id: "C004", patient_id: "P004" },
    })
  );

  // Verify deletion
  const verify = await dynamo.send(
    new GetCommand({
      TableName: table,
      Key: { call_id: "C004", patient_id: "P004" },
    })
  );

  const deleted = verify.Item === undefined;
  console.log(`C004/P004 deleted: ${deleted ? "PASS" : "FAIL — item still exists"}`);
  if (!deleted) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("fix-p004-callresult failed:", err);
  process.exit(1);
});
