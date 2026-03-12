import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { handler } from "./handler";

// ─── DynamoDB client (to read back generated SBARs) ──────────────────────────

const dynamoEndpoint = process.env["DYNAMO_ENDPOINT"];
const dynamoBase = new DynamoDBClient({
  region: process.env["AWS_REGION"] ?? "us-east-1",
  ...(dynamoEndpoint ? { endpoint: dynamoEndpoint } : {}),
});
const dynamo = DynamoDBDocumentClient.from(dynamoBase);

// ─── Test cases ───────────────────────────────────────────────────────────────

interface TestCase {
  callId: string;
  patientId: string;
  expectedStatus: string;
  mustContain: string[];
}

const testCases: TestCase[] = [
  {
    callId: "C001",
    patientId: "P001",
    expectedStatus: "RED",
    mustContain: ["AHA", "weight"],
  },
  {
    callId: "C002",
    patientId: "P002",
    expectedStatus: "YELLOW",
    mustContain: ["AAOS", "pain"],
  },
  {
    callId: "C003",
    patientId: "P003",
    expectedStatus: "GREEN",
    mustContain: ["S (Situation)", "R (Recommendation)"],
  },
  {
    callId: "C004",
    patientId: "P004",
    expectedStatus: "RED",
    mustContain: ["IDSA", "antibiotic"],
  },
  {
    callId: "C005",
    patientId: "P005",
    expectedStatus: "RED",
    mustContain: ["AHA", "chest"],
  },
  {
    callId: "C006",
    patientId: "P006",
    expectedStatus: "INCOMPLETE",
    mustContain: ["manual", "follow-up"],
  },
];

// ─── Check helpers ────────────────────────────────────────────────────────────

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const resultsTable = process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults";

  let sbarsGenerated = 0;
  let escalationsFired = 0;
  const checkSummary: Record<string, boolean> = {};

  for (const tc of testCases) {
    // 1. Invoke handler
    const result = await handler({ callId: tc.callId, patientId: tc.patientId });
    const res = result as Record<string, unknown>;

    // 2. Read updated SBAR from DynamoDB
    const readBack = await dynamo.send(
      new GetCommand({
        TableName: resultsTable,
        Key: { call_id: tc.callId, patient_id: tc.patientId },
      })
    );
    const sbarText = (readBack.Item?.["sbar_summary"] as string | undefined) ?? "";
    const guidelineSource = (res["guidelineSource"] as string | undefined) ?? "unknown";
    const wordCount = countWords(sbarText);

    // 3. Run checks
    const checkA = res["sbarGenerated"] === true;
    const checkB = sbarText.includes("S (Situation)");
    const checkC = sbarText.includes("B (Background)");
    const checkD = sbarText.includes("A (Assessment)");
    const checkE = sbarText.includes("R (Recommendation)");
    const checkF = tc.mustContain.every((term) =>
      sbarText.toLowerCase().includes(term.toLowerCase())
    );
    // Word floor by status: GREEN/INCOMPLETE are intentionally brief; RED/YELLOW need substance
    const minWords =
      tc.expectedStatus === "GREEN" || tc.expectedStatus === "INCOMPLETE" ? 30 : 70;
    const checkG = wordCount >= minWords && wordCount <= 400;
    const checkH = !sbarText.toLowerCase().includes(
      `patient ${tc.patientId.toLowerCase()} `
    );

    const allChecks = checkA && checkB && checkC && checkD && checkE && checkF && checkG && checkH;
    const passCount = [checkA, checkB, checkC, checkD, checkE, checkF, checkG, checkH].filter(
      Boolean
    ).length;

    if (allChecks) sbarsGenerated++;
    if (res["escalationTriggered"] === true) escalationsFired++;

    // 4. Print result line
    const statusLine = `[${tc.patientId}] ${tc.expectedStatus} — ${wordCount} words — guideline: ${guidelineSource}`;
    const checkLine = `         checks: ${passCount}/8 ${allChecks ? "PASS" : "FAIL"}`;

    if (!checkA) console.log(`  ✗ CHECK A (sbarGenerated): FAIL`);
    if (!checkB) console.log(`  ✗ CHECK B (S section): FAIL — "${sbarText.slice(0, 80)}"`);
    if (!checkC) console.log(`  ✗ CHECK C (B section): FAIL`);
    if (!checkD) console.log(`  ✗ CHECK D (A section): FAIL`);
    if (!checkE) console.log(`  ✗ CHECK E (R section): FAIL`);
    if (!checkF)
      console.log(
        `  ✗ CHECK F (mustContain): FAIL — missing: ${tc.mustContain.filter(
          (t) => !sbarText.toLowerCase().includes(t.toLowerCase())
        )}`
      );
    if (!checkG)
      console.log(`  ✗ CHECK G (word count ${wordCount}): FAIL — must be 80-400`);
    if (!checkH) console.log(`  ✗ CHECK H (PHI): FAIL — patient ID found as name`);

    console.log(statusLine);
    console.log(checkLine);

    // Track per-patient check result
    checkSummary[tc.patientId] = allChecks;
  }

  // ─── Print P001 full SBAR for clinical quality review ────────────────────────
  const p001Read = await dynamo.send(
    new GetCommand({
      TableName: resultsTable,
      Key: { call_id: "C001", patient_id: "P001" },
    })
  );
  const p001Sbar = (p001Read.Item?.["sbar_summary"] as string | undefined) ?? "";
  console.log("\n─────────────────────────────────────────────────");
  console.log("P001 FULL SBAR (clinical quality review):");
  console.log("─────────────────────────────────────────────────");
  console.log(p001Sbar);

  // ─── Summary report ───────────────────────────────────────────────────────────
  const overallPass = Object.values(checkSummary).every(Boolean);

  console.log("\n─────────────────────────────────────────────────");
  console.log("SECTION 6 — SBAR SUMMARIZER RESULTS");
  console.log("─────────────────────────────────────────────────");
  console.log(`SBARs generated:    ${sbarsGenerated}/6`);
  console.log(`Escalations fired:  ${escalationsFired}/6 (RED patients)`);
  console.log("─────────────────────────────────────────────────");
  console.log("Checks:");
  console.log(`P001 RED + AHA citation:      ${checkSummary["P001"] ? "PASS" : "FAIL"}`);
  console.log(`P002 YELLOW + AAOS citation:  ${checkSummary["P002"] ? "PASS" : "FAIL"}`);
  console.log(`P003 GREEN + S/B/A/R format:  ${checkSummary["P003"] ? "PASS" : "FAIL"}`);
  console.log(`P004 RED + IDSA citation:     ${checkSummary["P004"] ? "PASS" : "FAIL"}`);
  console.log(`P005 RED + AHA citation:      ${checkSummary["P005"] ? "PASS" : "FAIL"}`);
  console.log(`P006 INCOMPLETE + manual:     ${checkSummary["P006"] ? "PASS" : "FAIL"}`);
  console.log("─────────────────────────────────────────────────");
  console.log(
    `OVERALL: ${overallPass ? "SECTION 6 COMPLETE" : "ACTION REQUIRED"}`
  );
  console.log("─────────────────────────────────────────────────\n");

  if (!overallPass) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("local-test failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
