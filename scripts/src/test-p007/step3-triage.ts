/**
 * step3-triage.ts — Run the triage engine for C007/P007 and verify RED outcome.
 *
 * Expected:
 *   triageStatus:        RED
 *   brokenRules:         includes "shortness_of_breath == true"
 *                        includes "rescue_inhaler_use >= 3"
 *   escalationTriggered: true
 *   weightedScore:       >= 0.65  (0.9 + 0.8 + 0.75 + 0.7 = 3.15)
 */
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { handler } from "../../../packages/triage-engine/src/handler";

async function main(): Promise<void> {
  console.log("══════════════════════════════════════════════════════");
  console.log("STEP 3 — Triage Engine for C007/P007");
  console.log("══════════════════════════════════════════════════════\n");

  const result = (await handler({ callId: "C007", patientId: "P007" })) as Record<
    string,
    unknown
  >;

  const brokenRules = (result["brokenRules"] as string[] | undefined) ?? [];

  console.log("Triage result:");
  console.log(`  statusCode:          ${result["statusCode"]}`);
  console.log(`  triageStatus:        ${result["triageStatus"]}`);
  console.log(`  weightedScore:       ${result["weightedScore"]}`);
  console.log(`  escalationTriggered: ${result["escalationTriggered"]}`);
  console.log(`  laceScore:           ${result["laceScore"]}`);
  console.log(`  laceRiskLevel:       ${result["laceRiskLevel"]}`);
  console.log(`  brokenRules (${brokenRules.length}):`);
  for (const rule of brokenRules) {
    console.log(`    - ${rule}`);
  }
  if (result["incompleteReason"]) {
    console.log(`  incompleteReason:    ${result["incompleteReason"]}`);
  }

  const isRed = result["triageStatus"] === "RED";
  const hasSOB = brokenRules.some((r) => r.includes("shortness_of_breath == true"));
  const hasRescue = brokenRules.some((r) => r.includes("rescue_inhaler_use >= 3"));
  const escalated = result["escalationTriggered"] === true;

  const pass =
    result["statusCode"] === 200 &&
    isRed &&
    hasSOB &&
    hasRescue &&
    escalated;

  console.log("\n── Verification ──────────────────────────────────────");
  console.log(`  statusCode == 200:                  ${result["statusCode"] === 200 ? "PASS" : "FAIL"}`);
  console.log(`  triageStatus == RED:                ${isRed ? "PASS" : `FAIL (got ${result["triageStatus"]})`}`);
  console.log(`  brokenRules has shortness_of_breath: ${hasSOB ? "PASS" : "FAIL"}`);
  console.log(`  brokenRules has rescue_inhaler_use:  ${hasRescue ? "PASS" : "FAIL"}`);
  console.log(`  escalationTriggered == true:         ${escalated ? "PASS" : "FAIL"}`);
  console.log(`\nStep 3: ${pass ? "PASS" : "FAIL"}`);

  if (!pass) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("step3-triage failed:", err);
  process.exit(1);
});
