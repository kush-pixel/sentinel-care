/**
 * cleanup-stale.ts — Remove stale and test records from CallResults.
 *
 * Deletes records where:
 *   1. call_id starts with "TEST-" (any status) — test scaffolding records
 *   2. call_id starts with "CALL-" AND call_status != "COMPLETE"
 *      AND call_timestamp older than 2 hours — stuck in-progress records
 *
 * Keeps:
 *   - C001–C006 seeded demo records (call_id starts with "C" not "CALL-")
 *   - Any COMPLETE record regardless of age
 *
 * Run: cd scripts && npm run cleanup:stale
 */

import * as dotenv from "dotenv";
import * as path from "path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const REGION = process.env["AWS_REGION"]           ?? "us-east-1";
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
  console.log("SENTINEL — CLEANUP STALE RECORDS");
  console.log(SEP + "\n");

  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

  let lastKey: Record<string, unknown> | undefined;
  const toDelete: Array<{ call_id: string; patient_id: string; reason: string }> = [];
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
      const callId    = String(item["call_id"]        ?? "");
      const patientId = String(item["patient_id"]     ?? "");
      const status    = String(item["call_status"]    ?? "");
      const timestamp = String(item["call_timestamp"] ?? "");

      // Keep: demo records (start with "C" but NOT "CALL-")
      if (callId.startsWith("C") && !callId.startsWith("CALL-")) continue;

      // Keep: any COMPLETE record
      if (status === "COMPLETE") continue;

      // Delete: TEST- records (any status)
      if (callId.startsWith("TEST-")) {
        toDelete.push({ call_id: callId, patient_id: patientId, reason: "TEST- record" });
        continue;
      }

      // Delete: CALL- non-COMPLETE records older than 2 hours
      if (callId.startsWith("CALL-") && timestamp < cutoff) {
        toDelete.push({ call_id: callId, patient_id: patientId, reason: `stale ${status} (${timestamp.substring(0, 19)})` });
      }
    }

    lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  console.log(`  Scanned  : ${scanned} records`);
  console.log(`  To delete: ${toDelete.length} stale/test records`);
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
    console.log(`  ✓ Deleted ${key.call_id} (${key.patient_id}) — ${key.reason}`);
    deleted++;
  }

  console.log(`\n${SEP}`);
  console.log(`CLEANUP COMPLETE — ${deleted} records deleted`);
  console.log(SEP);
}

main().catch((err: unknown) => {
  console.error("cleanup:stale failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
