/**
 * demo-reset.ts — Reset P004 back to starting demo state.
 *
 * Reverses everything demo-p004-flow.ts did:
 *   - Deletes C004 from CallResults
 *   - Resets REV-P004-DEMO back to PENDING_REVIEW
 *   - Deletes P004 from TriageProtocols
 *
 * Idempotent: safe to run multiple times.
 */
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  UpdateCommand,
  GetCommand,
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

const SEP = "─────────────────────────────────────────────";

async function main(): Promise<void> {
  console.log(SEP);
  console.log("DEMO RESET");
  console.log(SEP + "\n");

  const dynamo = makeDynamo();
  const reviewsTable = process.env["DYNAMO_TABLE_REVIEWS"] ?? "ProtocolReview";
  const protocolsTable = process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols";
  const resultsTable = process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults";

  // ─── STEP 1 — Delete C004 from CallResults ───────────────────────────────────
  console.log("Step 1 — Deleting C004 from CallResults...");
  await dynamo.send(
    new DeleteCommand({
      TableName: resultsTable,
      Key: { call_id: "C004", patient_id: "P004" },
    })
  );
  console.log("  [DELETE] C004/P004 from CallResults\n");

  // ─── STEP 2 — Reset REV-P004-DEMO to PENDING_REVIEW ─────────────────────────
  console.log("Step 2 — Resetting REV-P004-DEMO to PENDING_REVIEW...");
  await dynamo.send(
    new UpdateCommand({
      TableName: reviewsTable,
      Key: { review_id: "REV-P004-DEMO", patient_id: "P004" },
      UpdateExpression:
        "SET #s = :s REMOVE reviewed_by, reviewed_at, approved_at, review_notes, regenerated_as, regeneration_triggered_at",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "PENDING_REVIEW" },
    })
  );
  console.log("  [UPDATE] REV-P004-DEMO → PENDING_REVIEW\n");

  // ─── STEP 3 — Delete P004 from TriageProtocols ───────────────────────────────
  console.log("Step 3 — Deleting P004 from TriageProtocols...");
  await dynamo.send(
    new DeleteCommand({
      TableName: protocolsTable,
      Key: { patient_id: "P004" },
    })
  );
  console.log("  [DELETE] P004 from TriageProtocols\n");

  // ─── STEP 4 — Verify reset state ─────────────────────────────────────────────
  console.log("Step 4 — Verifying reset state...");

  const [reviewCheck, callCheck] = await Promise.all([
    dynamo.send(
      new GetCommand({
        TableName: reviewsTable,
        Key: { review_id: "REV-P004-DEMO", patient_id: "P004" },
      })
    ),
    dynamo.send(
      new GetCommand({
        TableName: resultsTable,
        Key: { call_id: "C004", patient_id: "P004" },
      })
    ),
  ]);

  const reviewStatus = reviewCheck.Item?.["status"] as string | undefined;
  const callExists = callCheck.Item !== undefined;

  const reviewPass = reviewStatus === "PENDING_REVIEW";
  const callPass = !callExists;

  console.log(`  REV-P004-DEMO status: ${reviewStatus ?? "NOT FOUND"} — ${reviewPass ? "PASS" : "FAIL"}`);
  console.log(`  C004 in CallResults:  ${callExists ? "EXISTS (FAIL)" : "not found (PASS)"}`);

  // ─── Final summary ────────────────────────────────────────────────────────────
  const allPass = reviewPass && callPass;
  console.log();
  console.log(SEP);
  console.log("DEMO RESET COMPLETE");
  console.log(SEP);
  console.log(`  REV-P004-DEMO → PENDING_REVIEW ${reviewPass ? "✓" : "✗"}`);
  console.log(`  C004 deleted → no triage result ${callPass ? "✓" : "✗"}`);
  console.log(`  P004 hidden from Triage Results ${allPass ? "✓" : "✗"}`);
  console.log(`  Ready to run demo again ${allPass ? "✓" : "✗"}`);
  console.log(SEP + "\n");

  if (!allPass) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("demo-reset failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
