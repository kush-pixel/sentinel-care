import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { handler } from "./handler";

// ─── Types ────────────────────────────────────────────────────────────────────

interface HandlerResult {
  statusCode: number;
  patientId?: string;
  reviewId?: string;
  status?: string;
  confidenceScore?: number;
  autoApprovalReason?: string | null;
  pendingReason?: string | null;
  conditionCodes?: string[];
  rulesFound?: boolean;
  usedFallback?: boolean;
  laceScore?: number;
  laceRiskLevel?: string;
  audioGenerated?: number;
  audioMap?: Record<string, string>;
  preferredLanguage?: string;
  questionPriority?: string[];
  error?: string;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const PATIENT_IDS = ["P001", "P002", "P003", "P004", "P005", "P006"];

async function main(): Promise<void> {
  const results: Record<string, HandlerResult> = {};

  for (const patientId of PATIENT_IDS) {
    console.log(`\nProcessing ${patientId}...`);
    const result = (await handler({ patientId })) as HandlerResult;
    results[patientId] = result;

    const confidence = result.confidenceScore?.toFixed(2) ?? "N/A";
    const status = result.status ?? result.error ?? "ERROR";
    const lace = result.laceScore !== undefined
      ? `${result.laceScore}(${result.laceRiskLevel ?? "?"})`
      : "N/A";
    const rules = result.rulesFound !== undefined ? String(result.rulesFound) : "?";
    const fallback = result.usedFallback !== undefined ? String(result.usedFallback) : "?";
    const audio = result.audioGenerated ?? 0;

    console.log(
      `[${patientId}] confidence=${confidence} status=${status} lace=${lace} rules=${rules} fallback=${fallback} audio=${audio}`
    );

    // 2-second delay to avoid Bedrock rate limiting
    if (patientId !== "P006") {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────────────

  let autoApprovedCount = 0;
  let pendingCount = 0;
  let errorCount = 0;
  let rulesFoundCount = 0;
  let totalAudio = 0;

  for (const pid of PATIENT_IDS) {
    const r = results[pid];
    if (!r) continue;
    if (r.status === "AUTO_APPROVED") autoApprovedCount++;
    else if (r.status === "PENDING_REVIEW") pendingCount++;
    else errorCount++;
    if (r.rulesFound) rulesFoundCount++;
    totalAudio += r.audioGenerated ?? 0;
  }

  // ─── Checks ─────────────────────────────────────────────────────────────────

  const p005 = results["P005"];
  const p001 = results["P001"];
  const p004 = results["P004"];
  const p006 = results["P006"];

  const p005LangPass = p005?.preferredLanguage === "es";
  const p001TopQ = p001?.questionPriority?.[0];
  const p001TopQPass =
    p001TopQ === "weight_gain_lbs" || p001TopQ === "shortness_of_breath";
  const p001LacePass = p001?.laceScore === 10 && p001?.laceRiskLevel === "HIGH";
  const p006LacePass = p006?.laceScore === 4 && p006?.laceRiskLevel === "LOW";
  const p004StatusPass = p004?.status === "AUTO_APPROVED";

  const allPass =
    p005LangPass && p001TopQPass && p001LacePass && p006LacePass && p004StatusPass;

  const sep = "─────────────────────────────────────────────────────";
  console.log(`\n${sep}`);
  console.log("SECTION 3 — CARE PLANNER RESULTS");
  console.log(sep);
  console.log(`Auto-approved:    ${autoApprovedCount}/6`);
  console.log(`Pending review:   ${pendingCount}/6`);
  console.log(`Errors:           ${errorCount}/6`);
  console.log(`Rules found:      ${rulesFoundCount}/6`);
  console.log(`Audio generated:  ${totalAudio} total clips`);
  console.log(sep);
  console.log("Checks:");
  console.log(
    `P005 language:     ${p005?.preferredLanguage ?? "N/A"} (${p005LangPass ? "PASS" : "FAIL"})`
  );
  console.log(
    `P001 top question: ${p001TopQ ?? "N/A"} (${p001TopQPass ? "PASS" : "FAIL"})`
  );
  console.log(
    `P001 LACE:         ${p001?.laceScore ?? "?"} ${p001?.laceRiskLevel ?? "?"} (${p001LacePass ? "PASS" : "FAIL"})`
  );
  console.log(
    `P006 LACE:         ${p006?.laceScore ?? "?"} ${p006?.laceRiskLevel ?? "?"} (${p006LacePass ? "PASS" : "FAIL"})`
  );
  console.log(
    `P004 status:       ${p004?.status ?? "N/A"} (${p004StatusPass ? "PASS" : "FAIL"})`
  );
  console.log(sep);
  console.log(`OVERALL: ${allPass ? "SECTION 3 COMPLETE" : "ACTION REQUIRED"}`);
  console.log(sep);

  // ─── Save full results ───────────────────────────────────────────────────────

  const logsDir = path.resolve(__dirname, "../../logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const logPath = path.join(logsDir, "care-planner-test.json");
  fs.writeFileSync(
    logPath,
    JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2)
  );
  console.log(`\nFull results saved to ${logPath}`);
}

main().catch((err: unknown) => {
  console.error("local-test failed:", err);
  process.exit(1);
});
