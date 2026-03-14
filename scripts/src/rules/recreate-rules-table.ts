/**
 * recreate-rules-table.ts — Drop and recreate ClinicalRules with a sort key.
 *
 * The original table had only a hash key (condition_code).
 * Versioning requires a composite key:
 *   PK: condition_code (e.g. "J18.9")
 *   SK: version_id     (e.g. "J18.9#v1", "J18.9#v2", "LATEST")
 *
 * This script is idempotent: it deletes the table if it exists, then recreates it.
 */

import * as dotenv from "dotenv";
import * as path from "path";
import {
  DynamoDBClient,
  DeleteTableCommand,
  CreateTableCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function tableName(): string {
  return process.env["DYNAMO_TABLE_RULES"] ?? "ClinicalRules";
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function recreateRulesTable(): Promise<void> {
  const client = new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  });
  const table = tableName();

  // STEP 1 — Delete existing table (skip if not found)
  try {
    await client.send(new DeleteTableCommand({ TableName: table }));
    console.log(`Deleting table ${table}...`);
    // DynamoDB Local deletion is synchronous — brief pause for consistency
    await wait(500);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ResourceNotFoundException")) {
      console.log(`Table ${table} does not exist — creating fresh.`);
    } else {
      throw err;
    }
  }

  // STEP 2 — Create with composite key (PK + SK)
  await client.send(
    new CreateTableCommand({
      TableName: table,
      AttributeDefinitions: [
        { AttributeName: "condition_code", AttributeType: "S" },
        { AttributeName: "version_id",     AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "condition_code", KeyType: "HASH"  },
        { AttributeName: "version_id",     KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    })
  );

  // STEP 3 — Wait for ACTIVE (DynamoDB Local is nearly instant)
  let attempts = 0;
  while (attempts < 30) {
    const desc = await client.send(new DescribeTableCommand({ TableName: table }));
    if (desc.Table?.TableStatus === "ACTIVE") break;
    await wait(500);
    attempts++;
  }

  console.log(`✓ ClinicalRules table recreated with sort key (condition_code + version_id)`);
}

async function main(): Promise<void> {
  await recreateRulesTable();
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("recreate-rules-table failed:", err);
    process.exit(1);
  });
}
