/**
 * step4-summarizer.ts — Run the SBAR summarizer for C007/P007 and verify output.
 *
 * Expected:
 *   sbarGenerated:    true
 *   guidelineSource:  "GOLD COPD Guidelines 2024"
 *   triageStatus:     RED
 *   escalationTriggered: true
 */
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { handler } from "../../../lambdas/summarizer/src/handler";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

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
  console.log("STEP 4 — SBAR Summarizer for C007/P007");
  console.log("══════════════════════════════════════════════════════\n");

  const result = (await handler({ callId: "C007", patientId: "P007" })) as Record<
    string,
    unknown
  >;

  console.log("Summarizer result:");
  console.log(`  statusCode:          ${result["statusCode"]}`);
  console.log(`  sbarGenerated:       ${result["sbarGenerated"]}`);
  console.log(`  sbarLength:          ${result["sbarLength"]} chars`);
  console.log(`  guidelineSource:     ${result["guidelineSource"]}`);
  console.log(`  triageStatus:        ${result["triageStatus"]}`);
  console.log(`  escalationTriggered: ${result["escalationTriggered"]}`);
  console.log(`  usedFallback:        ${result["usedFallback"]}`);

  // Read back SBAR from DynamoDB to print a preview
  const dynamo = makeDynamo();
  const resultsTable = process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults";

  const check = await dynamo.send(
    new GetCommand({
      TableName: resultsTable,
      Key: { call_id: "C007", patient_id: "P007" },
    })
  );

  const sbar = (check.Item?.["sbar_summary"] as string | undefined) ?? "";
  const guidelineSource =
    (check.Item?.["guideline_source"] as string | undefined) ?? "";

  if (sbar) {
    console.log("\n── SBAR Preview (first 400 chars) ───────────────────");
    console.log(sbar.slice(0, 400));
    if (sbar.length > 400) console.log("...[truncated]");
  }

  const pass =
    result["statusCode"] === 200 &&
    result["sbarGenerated"] === true &&
    (result["guidelineSource"] as string | undefined)?.includes("GOLD") === true &&
    result["triageStatus"] === "RED";

  const hasGOLD = guidelineSource.includes("GOLD");

  console.log("\n── Verification ──────────────────────────────────────");
  console.log(`  statusCode == 200:                ${result["statusCode"] === 200 ? "PASS" : "FAIL"}`);
  console.log(`  sbarGenerated == true:            ${result["sbarGenerated"] === true ? "PASS" : "FAIL"}`);
  console.log(`  guidelineSource includes GOLD:    ${(result["guidelineSource"] as string | undefined)?.includes("GOLD") ? "PASS" : `FAIL (got "${result["guidelineSource"]}")`}`);
  console.log(`  DynamoDB guideline_source GOLD:   ${hasGOLD ? "PASS" : `FAIL (got "${guidelineSource}")`}`);
  console.log(`  triageStatus == RED:              ${result["triageStatus"] === "RED" ? "PASS" : `FAIL (got ${result["triageStatus"]})`}`);
  console.log(`\nStep 4: ${pass ? "PASS" : "FAIL"}`);

  if (!pass) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("step4-summarizer failed:", err);
  process.exit(1);
});
