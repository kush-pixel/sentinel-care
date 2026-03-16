/**
 * cleanup-calls.ts — Remove stale CallResults records from failed test runs.
 *
 * Deletes records where ALL of the following are true:
 *   1. call_status = "IN_PROGRESS"
 *   2. call_id starts with "CALL-" (not seeded demo records C001–C006)
 *   3. call_timestamp is older than 1 hour
 *
 * Keeps:
 *   - Any record with call_id starting with "C" (e.g. C001–C006 demo data)
 *   - Any COMPLETE record regardless of age
 *
 * Run: cd scripts && npm run cleanup:calls
 */

import * as dotenv from "dotenv";
import * as path from "path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const TABLE  = process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults";
const SEP    = "─────────────────────────────────────────────";

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: REGION,
    ...(process.env["DYNAMO_ENDPOINT"] ? { endpoint: process.env["DYNAMO_ENDPOINT"] } : {}),
  })
);

async function main(): Promise<void> {
  console.log(SEP);
  console.log("SENTINEL — CLEANUP STALE CALL RESULTS");
  console.log(SEP + "\n");

  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago

  // Scan everything — table is small enough
  let lastKey: Record<string, unknown> | undefined;
  const toDelete: Array<{ call_id: string; patient_id: string }> = [];
  let scanned = 0;

  do {
    const resp = await dynamo.send(
      new ScanCommand({
        TableName:         TABLE,
        ExclusiveStartKey: lastKey as Record<string, unknown> | undefined,
      })
    );

    for (const item of resp.Items ?? []) {
      scanned++;
      const callId     = String(item["call_id"]    ?? "");
      const patientId  = String(item["patient_id"] ?? "");
      const status     = String(item["call_status"] ?? "");
      const timestamp  = String(item["call_timestamp"] ?? "");

      // Keep: any demo record (C001–C006) or any COMPLETE record
      if (!callId.startsWith("CALL-")) continue;
      if (status === "COMPLETE") continue;

      // Delete: IN_PROGRESS (or any non-COMPLETE) CALL-* records older than 1 hour
      if (timestamp < cutoff) {
        toDelete.push({ call_id: callId, patient_id: patientId });
      }
    }

    lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  console.log(`  Scanned  : ${scanned} records`);
  console.log(`  To delete: ${toDelete.length} stale IN_PROGRESS records`);
  console.log(`  Cutoff   : ${cutoff}\n`);

  if (toDelete.length === 0) {
    console.log("  Nothing to clean up.");
    console.log("\n" + SEP);
    return;
  }

  let deleted = 0;
  for (const key of toDelete) {
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { call_id: key.call_id, patient_id: key.patient_id },
      })
    );
    console.log(`  ✓ Deleted ${key.call_id} (patient ${key.patient_id})`);
    deleted++;
  }

  console.log(`\n${SEP}`);
  console.log(`CLEANUP COMPLETE — ${deleted} records deleted`);
  console.log(SEP);
}

main().catch((err: unknown) => {
  console.error("cleanup:calls failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
