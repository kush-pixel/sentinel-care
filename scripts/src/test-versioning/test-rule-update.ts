/**
 * test-rule-update.ts — Verify rule versioning end-to-end, fully isolated.
 *
 * Uses condition code "TEST-001" — never touches production rules or
 * ProtocolReview records. All test data is deleted in a finally block
 * regardless of pass/fail.
 *
 * Tests:
 *   1. Write TEST-001#v1 + LATEST pointer to ClinicalRules
 *   2. getLatestRule returns v1
 *   3. createNewRuleVersion creates v2, supersedes v1, updates LATEST
 *   4. getRuleVersion("TEST-001", "TEST-001#v1") returns original v1
 *   5. getRuleVersion("TEST-001", "TEST-001#v2") returns v2
 *
 * Run: cd scripts && npm run test:versioning
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

process.env["AWS_REGION"]         = process.env["AWS_REGION"]         ?? "us-east-1";
process.env["DYNAMO_TABLE_RULES"] = process.env["DYNAMO_TABLE_RULES"] ?? "ClinicalRules";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { getLatestRule, getRuleVersion, createNewRuleVersion } from "@sentinel/validation";

// ─── DynamoDB client ──────────────────────────────────────────────────────────

function makeDynamo(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"] && { endpoint: process.env["DYNAMO_ENDPOINT"] }),
  });
  return DynamoDBDocumentClient.from(raw);
}

const SEP = "─────────────────────────────────────────────";

type TestResult = { label: string; pass: boolean; detail: string };

// ─── Seed helper — write TEST-001 v1 + LATEST ────────────────────────────────

async function seedTestRule(
  dynamo: DynamoDBDocumentClient,
  rulesTable: string
): Promise<void> {
  const now = new Date().toISOString();

  const v1Record = {
    condition_code:         "TEST-001",
    version_id:             "TEST-001#v1",
    version:                1,
    is_latest:              true,
    condition_display:      "Test condition for versioning",
    guideline_source:       "Test Guidelines",
    guideline_url:          "https://example.com/test",
    last_reviewed:          "2024-01-01",
    reviewed_by:            "TEST",
    flag_color:             "RED",
    readmission_risk_level: "HIGH",
    question_priority:      ["test_symptom"],
    conditions: [
      {
        variable:      "test_symptom",
        operator:      "==",
        threshold:     true,
        weight:        0.9,
        flag_color:    "RED",
        clinical_note: "Test condition",
        source:        "Test Guidelines",
      },
    ],
    logic:              "OR",
    weighted_threshold: 0.65,
    effective_from:     now,
    superseded_by:      null,
    change_notes:       "Initial test rule",
    created_by:         "TEST",
    created_at:         now,
  };

  const latestRecord = {
    condition_code:    "TEST-001",
    version_id:        "LATEST",
    latest_version:    1,
    latest_version_id: "TEST-001#v1",
    updated_at:        now,
  };

  await dynamo.send(new PutCommand({ TableName: rulesTable, Item: v1Record }));
  await dynamo.send(new PutCommand({ TableName: rulesTable, Item: latestRecord }));
}

// ─── Cleanup helper — delete all TEST-001 records ────────────────────────────

async function cleanupTestRule(
  dynamo: DynamoDBDocumentClient,
  rulesTable: string
): Promise<void> {
  const versionIds = ["TEST-001#v1", "TEST-001#v2", "LATEST"];
  for (const versionId of versionIds) {
    await dynamo.send(
      new DeleteCommand({
        TableName: rulesTable,
        Key: { condition_code: "TEST-001", version_id: versionId },
      })
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dynamo     = makeDynamo();
  const rulesTable = process.env["DYNAMO_TABLE_RULES"] ?? "ClinicalRules";
  const results: TestResult[] = [];

  function record(label: string, pass: boolean, detail: string): void {
    results.push({ label, pass, detail });
    console.log(`  ${pass ? "✓" : "✗"} ${label} — ${detail}`);
  }

  console.log(SEP);
  console.log("RULE VERSIONING TEST  (isolated — TEST-001 only)");
  console.log(SEP + "\n");

  try {
    // ─── Setup ───────────────────────────────────────────────────────────────
    console.log("Setup — Writing TEST-001#v1 + LATEST...");
    await seedTestRule(dynamo, rulesTable);
    console.log("  ✓ TEST-001#v1 and LATEST pointer written\n");

    // ─── TEST 1 — getLatestRule returns v1 ───────────────────────────────────
    console.log("TEST 1 — getLatestRule(\"TEST-001\")...");
    const latest = await getLatestRule("TEST-001", dynamo, rulesTable);
    const rawLatest = latest as Record<string, unknown> | null;
    const t1Pass =
      rawLatest?.["version"] === 1 &&
      rawLatest?.["version_id"] === "TEST-001#v1";
    record(
      "TEST-001#v1 created",
      t1Pass,
      latest
        ? `v${String(rawLatest?.["version"])} (${String(rawLatest?.["version_id"])})`
        : "rule not found"
    );

    if (!latest) {
      console.error("  Cannot continue — TEST-001 not found after seed.");
      process.exit(1);
    }

    // ─── TEST 2 — createNewRuleVersion produces v2 ───────────────────────────
    console.log("\nTEST 2 — createNewRuleVersion(\"TEST-001\")...");
    const { versionId: newVersionId, version: newVersion } = await createNewRuleVersion(
      "TEST-001",
      {},
      "Updated test rule — added threshold adjustment",
      "TEST",
      dynamo,
      rulesTable
    );
    const t2Pass = newVersionId === "TEST-001#v2" && newVersion === 2;
    record("TEST-001#v2 created", t2Pass, `${newVersionId} (v${newVersion})`);

    // ─── TEST 3 — v1 is superseded ───────────────────────────────────────────
    console.log("\nTEST 3 — Verify v1 superseded...");
    const v1After = await getRuleVersion("TEST-001", "TEST-001#v1", dynamo, rulesTable);
    const rawV1After = v1After as Record<string, unknown> | null;
    const t3Pass =
      rawV1After?.["superseded_by"] === "TEST-001#v2" &&
      rawV1After?.["is_latest"] === false;
    record(
      "v1 marked superseded",
      t3Pass,
      `is_latest=${String(rawV1After?.["is_latest"])}, superseded_by=${String(rawV1After?.["superseded_by"])}`
    );

    // ─── TEST 4 — LATEST pointer updated ─────────────────────────────────────
    console.log("\nTEST 4 — Verify LATEST pointer...");
    const latestPtr = await dynamo.send(
      new GetCommand({
        TableName: rulesTable,
        Key: { condition_code: "TEST-001", version_id: "LATEST" },
      })
    );
    const t4Pass = latestPtr.Item?.["latest_version_id"] === "TEST-001#v2";
    record(
      "LATEST points to v2",
      t4Pass,
      `latest_version_id=${String(latestPtr.Item?.["latest_version_id"])}`
    );

    // ─── TEST 5 — getRuleVersion returns exact v1 ────────────────────────────
    console.log("\nTEST 5 — getRuleVersion(\"TEST-001\", \"TEST-001#v1\")...");
    const v1Fetched = await getRuleVersion("TEST-001", "TEST-001#v1", dynamo, rulesTable);
    const rawV1 = v1Fetched as Record<string, unknown> | null;
    const t5Pass =
      rawV1?.["version_id"] === "TEST-001#v1" &&
      rawV1?.["version"] === 1;
    record(
      "getRuleVersion returns correct v1",
      t5Pass,
      v1Fetched
        ? `version_id=${String(rawV1?.["version_id"])}, version=${String(rawV1?.["version"])}`
        : "not found"
    );

    // ─── TEST 6 — getRuleVersion returns exact v2 ────────────────────────────
    console.log("\nTEST 6 — getRuleVersion(\"TEST-001\", \"TEST-001#v2\")...");
    const v2Fetched = await getRuleVersion("TEST-001", "TEST-001#v2", dynamo, rulesTable);
    const rawV2 = v2Fetched as Record<string, unknown> | null;
    const t6Pass =
      rawV2?.["version_id"] === "TEST-001#v2" &&
      rawV2?.["version"] === 2 &&
      rawV2?.["is_latest"] === true;
    record(
      "getRuleVersion returns correct v2",
      t6Pass,
      v2Fetched
        ? `version_id=${String(rawV2?.["version_id"])}, version=${String(rawV2?.["version"])}, is_latest=${String(rawV2?.["is_latest"])}`
        : "not found"
    );

  } finally {
    // ─── Cleanup — always runs, even on failure ───────────────────────────────
    console.log("\nCleanup — Deleting all TEST-001 records...");
    await cleanupTestRule(dynamo, rulesTable);
    console.log("  ✓ Test data cleaned up");
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  console.log("\n" + SEP);
  console.log("RULE VERSIONING TEST");
  console.log(SEP);

  for (const r of results) {
    console.log(`  ${r.label.padEnd(38)} ${r.pass ? "PASS" : "FAIL"}`);
  }

  const allPass = results.every((r) => r.pass);
  console.log(SEP);
  console.log(`OVERALL: ${allPass ? "PASS" : "FAIL"}`);
  console.log(SEP);

  if (!allPass) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("test-versioning failed:", err);
  process.exit(1);
});
