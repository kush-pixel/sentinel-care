import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { TriageProtocol, PatientAnswers } from "@sentinel/schemas";
import { evaluateProtocol } from "./evaluator";

// ─── DynamoDB client ──────────────────────────────────────────────────────────

const docClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  })
);

// ─── Test cases ───────────────────────────────────────────────────────────────

const testCases = [
  { patientId: "P001", callId: "C001", expectedStatus: "RED"        },
  { patientId: "P002", callId: "C002", expectedStatus: "YELLOW"     },
  { patientId: "P003", callId: "C003", expectedStatus: "GREEN"      },
  { patientId: "P004", callId: "C004", expectedStatus: "RED"        },
  { patientId: "P005", callId: "C005", expectedStatus: "RED"        },
  { patientId: "P006", callId: "C006", expectedStatus: "INCOMPLETE" },
];

// ─── Result accumulator ───────────────────────────────────────────────────────

interface TestResult {
  patientId:     string;
  actualStatus:  string;
  expectedStatus: string;
  brokenRules:   string[];
  weightedScore: number | undefined;
  skippedCount:  number;
  laceScore:     number;
  laceRiskLevel: string;
  pass:          boolean;
  error?:        string;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results: TestResult[] = [];

  for (const tc of testCases) {
    try {
      // 1. Load protocol
      const protocolResp = await docClient.send(
        new GetCommand({
          TableName: process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols",
          Key: { patient_id: tc.patientId },
        })
      );

      if (!protocolResp.Item) {
        results.push({
          patientId:      tc.patientId,
          actualStatus:   "ERROR",
          expectedStatus: tc.expectedStatus,
          brokenRules:    [],
          weightedScore:  undefined,
          skippedCount:   0,
          laceScore:      0,
          laceRiskLevel:  "UNKNOWN",
          pass:           false,
          error:          "Protocol not found in TriageProtocols",
        });
        continue;
      }

      const protocol      = protocolResp.Item["protocol"]        as TriageProtocol;
      const laceScore     = (protocolResp.Item["lace_score"]      as number | undefined) ?? 0;
      const laceRiskLevel = (protocolResp.Item["lace_risk_level"] as string | undefined) ?? "UNKNOWN";

      // 2. Load patient answers
      const callResp = await docClient.send(
        new GetCommand({
          TableName: process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults",
          Key: {
            call_id:    tc.callId,
            patient_id: tc.patientId,
          },
        })
      );

      if (!callResp.Item) {
        results.push({
          patientId:      tc.patientId,
          actualStatus:   "ERROR",
          expectedStatus: tc.expectedStatus,
          brokenRules:    [],
          weightedScore:  undefined,
          skippedCount:   0,
          laceScore,
          laceRiskLevel,
          pass:           false,
          error:          "Call result not found in CallResults",
        });
        continue;
      }

      const answers = callResp.Item as unknown as PatientAnswers;

      // 3. Evaluate — directly, not via Lambda handler
      const triageResult = evaluateProtocol(protocol, answers, laceRiskLevel);

      const skippedCount = triageResult.nodeResult.conditionResults
        .filter((r) => r.actualValue === undefined)
        .length;

      const pass = triageResult.flagColor === tc.expectedStatus;

      results.push({
        patientId:      tc.patientId,
        actualStatus:   triageResult.flagColor,
        expectedStatus: tc.expectedStatus,
        brokenRules:    triageResult.brokenRules,
        weightedScore:  triageResult.weightedScore,
        skippedCount,
        laceScore,
        laceRiskLevel,
        pass,
      });

      const score = triageResult.weightedScore !== undefined
        ? triageResult.weightedScore.toFixed(2)
        : "N/A";

      console.log(
        `[${tc.patientId}] triage=${triageResult.flagColor} ` +
        `rules=${triageResult.brokenRules.length} score=${score} ` +
        `skipped=${skippedCount} lace=${laceScore}(${laceRiskLevel}) ` +
        `(${pass ? "PASS" : "FAIL"})`
      );

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        patientId:      tc.patientId,
        actualStatus:   "ERROR",
        expectedStatus: tc.expectedStatus,
        brokenRules:    [],
        weightedScore:  undefined,
        skippedCount:   0,
        laceScore:      0,
        laceRiskLevel:  "UNKNOWN",
        pass:           false,
        error:          msg,
      });
      console.log(`[${tc.patientId}] ERROR: ${msg}`);
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────────────

  const counts = { RED: 0, YELLOW: 0, GREEN: 0, INCOMPLETE: 0 };
  for (const r of results) {
    if (r.actualStatus === "RED")        counts.RED++;
    else if (r.actualStatus === "YELLOW")     counts.YELLOW++;
    else if (r.actualStatus === "GREEN")      counts.GREEN++;
    else if (r.actualStatus === "INCOMPLETE") counts.INCOMPLETE++;
  }

  const sep = "─────────────────────────────────────────────────";
  console.log(`\n${sep}`);
  console.log("SECTION 4 — TRIAGE ENGINE RESULTS");
  console.log(sep);
  console.log(`RED:        ${counts.RED}/6`);
  console.log(`YELLOW:     ${counts.YELLOW}/6`);
  console.log(`GREEN:      ${counts.GREEN}/6`);
  console.log(`INCOMPLETE: ${counts.INCOMPLETE}/6`);
  console.log(sep);
  console.log("Checks:");

  const checks = [
    { patientId: "P001", expected: "RED",        label: "P001 RED:       " },
    { patientId: "P002", expected: "YELLOW",     label: "P002 YELLOW:    " },
    { patientId: "P003", expected: "GREEN",      label: "P003 GREEN:     " },
    { patientId: "P004", expected: "RED",        label: "P004 RED:       " },
    { patientId: "P005", expected: "RED",        label: "P005 RED:       " },
    { patientId: "P006", expected: "INCOMPLETE", label: "P006 INCOMPLETE:" },
  ];

  let allPass = true;
  for (const check of checks) {
    const r = results.find((x) => x.patientId === check.patientId);
    const pass = r?.pass ?? false;
    if (!pass) allPass = false;
    console.log(`${check.label} ${pass ? "PASS" : "FAIL"}${r?.error ? ` (${r.error})` : ""}`);
  }

  console.log(sep);
  console.log(`OVERALL: ${allPass ? "SECTION 4 COMPLETE" : "ACTION REQUIRED"}`);
  console.log(sep);
}

main().catch((err: unknown) => {
  console.error("local-test failed:", err);
  process.exit(1);
});
