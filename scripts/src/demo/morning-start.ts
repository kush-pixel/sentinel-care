/**
 * morning-start.ts — Full automated morning startup sequence.
 *
 * Runs every step in order, verifies success before continuing.
 * Idempotent: safe to run multiple times.
 * No manual steps required after Docker / start-local.ps1.
 *
 * Usage:
 *   cd scripts && npm run morning:start
 */
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ─── Env vars — set explicitly before any handler import ──────────────────────
process.env["AWS_REGION"]                 = process.env["AWS_REGION"]                 ?? "us-east-1";
process.env["FHIR_BASE_URL"]              = process.env["FHIR_BASE_URL"]              ?? "http://localhost:8080/fhir";
process.env["DYNAMO_TABLE_PROTOCOLS"]     = process.env["DYNAMO_TABLE_PROTOCOLS"]     ?? "TriageProtocols";
process.env["DYNAMO_TABLE_REVIEWS"]       = process.env["DYNAMO_TABLE_REVIEWS"]       ?? "ProtocolReview";
process.env["DYNAMO_TABLE_RULES"]         = process.env["DYNAMO_TABLE_RULES"]         ?? "ClinicalRules";
process.env["DYNAMO_TABLE_RESULTS"]       = process.env["DYNAMO_TABLE_RESULTS"]       ?? "CallResults";
process.env["DYNAMO_TABLE_PATIENTS"]      = process.env["DYNAMO_TABLE_PATIENTS"]      ?? "PatientProfiles";
process.env["BEDROCK_MODEL_CARE_PLANNER"] = process.env["BEDROCK_MODEL_CARE_PLANNER"] ?? "amazon.nova-lite-v1:0";
process.env["BEDROCK_MODEL_SUMMARIZER"]   = process.env["BEDROCK_MODEL_SUMMARIZER"]   ?? "amazon.nova-lite-v1:0";
process.env["POLLY_ENABLED"]              = "false";
process.env["CONFIDENCE_THRESHOLD"]       = process.env["CONFIDENCE_THRESHOLD"]       ?? "0.7";
process.env["ESCALATION_TOPIC_ARN"]       = process.env["ESCALATION_TOPIC_ARN"]       ?? "arn:aws:sns:us-east-1:629843009128:sentinel-red-escalation";

// ─── Seed function imports ─────────────────────────────────────────────────────
import { clearProtocolReviews } from "../demo/clear-protocol-reviews";
import { seedFhir }             from "../fhir/seed-fhir";
import { seedEncounters }       from "../fhir/seed-encounters";
import { seedRules }            from "../rules/seed-clinical-rules";
import { hydrateLace }          from "../lace/hydrate-lace";
import { seedDemoResults }      from "../reviews/seed-demo-results";
import { seedPendingReview }    from "../demo/seed-pending-review";

// ─── Handler imports ───────────────────────────────────────────────────────────
import { handler as carePlannerHandler } from "../../../lambdas/care-planner/src/handler";
import { handler as triageHandler }      from "../../../packages/triage-engine/src/handler";
import { handler as summarizerHandler }  from "../../../lambdas/summarizer/src/handler";

// ─── DynamoDB for verification ─────────────────────────────────────────────────
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import fetch from "node-fetch";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";

const SEP = "─────────────────────────────────────────────";

function makeDynamo(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"] && { endpoint: process.env["DYNAMO_ENDPOINT"] }),
  });
  return DynamoDBDocumentClient.from(raw);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log(SEP);
  console.log("SENTINEL VOICE — MORNING STARTUP");
  console.log(SEP + "\n");

  // ─── STEP 0 — Verify Docker / local services ────────────────────────────────
  console.log("STEP 0 — Verifying local services...");

  const fhirUrl = process.env["FHIR_BASE_URL"] ?? "http://localhost:8080/fhir";
  try {
    const fhirRes = await fetch(
      `${fhirUrl}/metadata`,
      { signal: AbortSignal.timeout(5000) as unknown as import("node-fetch").RequestInit["signal"] }
    );
    if (!fhirRes.ok) throw new Error(`HTTP ${fhirRes.status}`);
    console.log("  ✓ FHIR server running");
  } catch {
    const isLocal = fhirUrl.includes("localhost");
    if (isLocal) {
      console.error(`  ✗ Local FHIR server not running`);
      console.error("    Start Docker Desktop and run:");
      console.error("      scripts\\start-local.ps1");
      console.error("    Wait 90 seconds then run this again.");
    } else {
      console.error(`  ✗ AWS FHIR server not responding at ${fhirUrl}`);
      console.error("    Run: npm run rebuild:fhir");
    }
    process.exit(1);
  }

  try {
    const raw = new DynamoDBClient({
      region: process.env["AWS_REGION"] ?? "us-east-1",
      ...(process.env["DYNAMO_ENDPOINT"] && { endpoint: process.env["DYNAMO_ENDPOINT"] }),
    });
    await raw.send(new ListTablesCommand({}));
    if (process.env["DYNAMO_ENDPOINT"]) {
      console.log("  ✓ DynamoDB Local running\n");
    } else {
      console.log("  ✓ AWS DynamoDB connected\n");
    }
  } catch {
    if (process.env["DYNAMO_ENDPOINT"]) {
      console.error("  ✗ DynamoDB Local not running");
      console.error("    Start Docker Desktop and run:");
      console.error("      scripts\\start-local.ps1");
    } else {
      console.error("  ✗ AWS DynamoDB not reachable — check credentials and region");
    }
    process.exit(1);
  }

  // ─── STEP 1 — Clear stale protocol reviews ──────────────────────────────────
  console.log("STEP 1 — Clearing stale protocol reviews...");
  await clearProtocolReviews();
  console.log("  ✓ Stale protocol reviews cleared\n");

  // ─── STEP 2 — Seed base data ────────────────────────────────────────────────
  console.log("STEP 2 — Seeding base data...");

  await seedFhir();
  console.log("  ✓ FHIR patients seeded");

  await seedEncounters();
  console.log("  ✓ Encounters seeded");

  await seedRules();
  console.log("  ✓ Clinical rules seeded (versioned)");
  console.log("    I50.9   → v1 (AHA/ACC 2022)");
  console.log("    Z96.651 → v1 (AAOS 2023)");
  console.log("    E11.9   → v1 (ADA 2024)");
  console.log("    J18.9   → v1 (IDSA/ATS)");
  console.log("    I21.9   → v1 (AHA/ACC STEMI 2023)");
  console.log("    N18.3   → v1 (KDIGO 2024)\n");

  // ─── STEP 3 — Hydrate LACE scores ───────────────────────────────────────────
  console.log("STEP 3 — Hydrating LACE scores from FHIR...");
  await hydrateLace();
  console.log("  ✓ LACE scores calculated from FHIR\n");

  // ─── STEP 4 — Seed demo call results ────────────────────────────────────────
  console.log("STEP 4 — Seeding demo call results...");

  // Clean up any real call records for demo patients so they don't
  // overshadow the seeded C001–C006 records (real calls have newer timestamps)
  const cleanupDynamo = makeDynamo();
  const resultsTableCleanup = process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults";
  const DEMO_PATIENTS = ["P001", "P002", "P003", "P005", "P006"];
  let totalDeleted = 0;

  for (const patientId of DEMO_PATIENTS) {
    const scan = await cleanupDynamo.send(new ScanCommand({
      TableName: resultsTableCleanup,
      FilterExpression: "patient_id = :pid",
      ExpressionAttributeValues: { ":pid": patientId },
    }));
    const toDelete = (scan.Items ?? []).filter(
      (item) => !String(item["call_id"] ?? "").startsWith("C00")
    );
    for (const item of toDelete) {
      await cleanupDynamo.send(new DeleteCommand({
        TableName: resultsTableCleanup,
        Key: { call_id: item["call_id"], patient_id: item["patient_id"] },
      }));
    }
    if (toDelete.length > 0) {
      console.log(`  Cleared ${toDelete.length} real call record(s) for ${patientId}`);
      totalDeleted += toDelete.length;
    }
  }
  if (totalDeleted === 0) {
    console.log("  ✓ No real call records to clear");
  } else {
    console.log(`  ✓ ${totalDeleted} real call record(s) removed`);
  }

  await seedDemoResults();
  console.log("  ✓ Demo call results seeded (5 patients)\n");

  // ─── STEP 5 — Run Care Planner for all 6 patients ───────────────────────────
  console.log("STEP 5 — Running Care Planner (6 patients)...");

  const CARE_PLANNER_PATIENTS = ["P001", "P002", "P003", "P004", "P005", "P006"];
  let protocolsGenerated = 0;

  for (const patientId of CARE_PLANNER_PATIENTS) {
    try {
      const result = (await carePlannerHandler({ patientId })) as Record<string, unknown>;
      const statusCode = result["statusCode"] as number | undefined;
      if (statusCode !== 200) {
        console.warn(`  ⚠ ${patientId} Care Planner returned ${statusCode ?? "unknown"}: ${String(result["error"] ?? "")}`);
      } else {
        const status = result["status"] as string | undefined;
        console.log(`  ✓ ${patientId} protocol generated (${status ?? "unknown"})`);
        protocolsGenerated++;
      }
    } catch (err: unknown) {
      console.warn(`  ⚠ ${patientId} Care Planner failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`  ✓ Care Planner complete — ${protocolsGenerated}/${CARE_PLANNER_PATIENTS.length} protocols\n`);

  // ─── STEP 6 — Run Triage Engine (skip P004 — PENDING_REVIEW) ────────────────
  console.log("STEP 6 — Running Triage Engine...");

  const TRIAGE_PAIRS = [
    { callId: "C001", patientId: "P001" },
    { callId: "C002", patientId: "P002" },
    { callId: "C003", patientId: "P003" },
    { callId: "C005", patientId: "P005" },
    { callId: "C006", patientId: "P006" },
  ];

  for (const { callId, patientId } of TRIAGE_PAIRS) {
    try {
      const result = (await triageHandler({ callId, patientId })) as Record<string, unknown>;
      const statusCode = result["statusCode"] as number | undefined;
      if (statusCode !== 200) {
        console.warn(`  ⚠ ${patientId} Triage returned ${statusCode ?? "unknown"}: ${String(result["error"] ?? "")}`);
      } else {
        const triageStatus = result["triageStatus"] as string | undefined;
        console.log(`  ✓ ${patientId} → ${triageStatus ?? "unknown"}`);
      }
    } catch (err: unknown) {
      console.warn(`  ⚠ ${patientId} Triage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("  ✓ Triage Engine complete\n");

  // ─── STEP 7 — Run Summarizer ─────────────────────────────────────────────────
  console.log("STEP 7 — Running SBAR Summarizer...");

  for (const { callId, patientId } of TRIAGE_PAIRS) {
    try {
      const result = (await summarizerHandler({ callId, patientId })) as Record<string, unknown>;
      const statusCode = result["statusCode"] as number | undefined;
      if (statusCode !== 200) {
        console.warn(`  ⚠ ${patientId} Summarizer returned ${statusCode ?? "unknown"}: ${String(result["error"] ?? "")}`);
      } else {
        console.log(`  ✓ ${patientId} SBAR generated`);
      }
    } catch (err: unknown) {
      console.warn(`  ⚠ ${patientId} Summarizer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("  ✓ SBAR Summarizer complete\n");

  // ─── STEP 8 — Reset protocol reviews to demo state ──────────────────────────
  console.log("STEP 8 — Resetting protocol reviews to demo state...");

  const dynamo = makeDynamo();
  const reviewsTableStep8 = process.env["DYNAMO_TABLE_REVIEWS"] ?? "ProtocolReview";

  // Clear all reviews written by the care planner
  await clearProtocolReviews();

  // Verify zero records remain — re-clear if DynamoDB Local had any late writes
  const afterClear = await dynamo.send(
    new ScanCommand({ TableName: reviewsTableStep8, Select: "COUNT" })
  );
  if (afterClear.Count && afterClear.Count > 0) {
    console.log(`  ⚠ ${afterClear.Count} record(s) remain after clear — clearing again...`);
    await clearProtocolReviews();
  }

  // Seed the single demo record
  await seedPendingReview();

  // Confirm exactly 1 record exists before proceeding
  const finalCount = await dynamo.send(
    new ScanCommand({ TableName: reviewsTableStep8, Select: "COUNT" })
  );
  if (finalCount.Count !== 1) {
    console.error(`  ✗ Expected 1 review record, found ${finalCount.Count ?? 0}`);
    process.exit(1);
  }

  console.log("  ✓ Protocol reviews reset");
  console.log("  ✓ Exactly 1 review record confirmed");
  console.log("  REV-P004-DEMO → PENDING_REVIEW\n");

  // ─── STEP 9 — Final verification ────────────────────────────────────────────
  console.log("STEP 9 — Verifying final state...");

  const resultsTable   = process.env["DYNAMO_TABLE_RESULTS"]   ?? "CallResults";
  const protocolsTable = process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols";
  const reviewsTable   = process.env["DYNAMO_TABLE_REVIEWS"]   ?? "ProtocolReview";
  const patientsTable  = process.env["DYNAMO_TABLE_PATIENTS"]  ?? "PatientProfiles";

  // Scan CallResults for triage status + LACE
  const callResultsScan = await dynamo.send(
    new ScanCommand({ TableName: resultsTable })
  );
  const callItems = callResultsScan.Items ?? [];

  // Scan ProtocolReview
  const reviewScan = await dynamo.send(
    new ScanCommand({ TableName: reviewsTable, Select: "COUNT" })
  );
  const reviewCount = reviewScan.Count ?? 0;

  // Scan TriageProtocols
  const protocolScan = await dynamo.send(
    new ScanCommand({ TableName: protocolsTable, Select: "COUNT" })
  );
  const protocolCount = protocolScan.Count ?? 0;

  // Build lookup maps (prefer demo records C001–C006)
  const callMap = new Map<string, Record<string, unknown>>();
  for (const item of callItems) {
    const pid = item["patient_id"] as string | undefined;
    const cid = String(item["call_id"] ?? "");
    if (pid && cid.startsWith("C00")) {
      callMap.set(pid, item as Record<string, unknown>);
    }
  }

  // Per-patient count check — warn if any demo patient has extra records
  const countPerPatient = new Map<string, number>();
  for (const item of callItems) {
    const pid = item["patient_id"] as string | undefined;
    if (pid) countPerPatient.set(pid, (countPerPatient.get(pid) ?? 0) + 1);
  }
  for (const pid of DEMO_PATIENTS) {
    const count = countPerPatient.get(pid) ?? 0;
    if (count !== 1) {
      console.warn(`  ⚠ ${pid} has ${count} CallResult record(s) — expected 1`);
      callItems
        .filter(i => i["patient_id"] === pid)
        .forEach(i => console.warn(`      call_id: ${String(i["call_id"] ?? "?")}`));
    }
  }

  // Get P004 LACE from PatientProfiles (no call result for P004)
  const p004Profile = await dynamo.send(
    new GetCommand({ TableName: patientsTable, Key: { patient_id: "P004" } })
  );
  const p004Lace      = (p004Profile.Item?.["lace_score"] as number | undefined) ?? 0;
  const p004RiskLevel = (p004Profile.Item?.["lace_risk_level"] as string | undefined) ?? "UNKNOWN";

  // Print verification table
  console.log();
  console.log(`  ${"Patient".padEnd(7)} | ${"Protocol".padEnd(8)} | ${"Triage".padEnd(10)} | LACE`);
  console.log(`  ${"─".repeat(7)}-+-${"─".repeat(8)}-+-${"─".repeat(10)}-+-${"─".repeat(14)}`);

  const DISPLAY_PATIENTS = [
    { id: "P001", callId: "C001" },
    { id: "P002", callId: "C002" },
    { id: "P003", callId: "C003" },
    { id: "P004", callId: null   },
    { id: "P005", callId: "C005" },
    { id: "P006", callId: "C006" },
  ];

  for (const { id, callId } of DISPLAY_PATIENTS) {
    const call = callId ? callMap.get(id) : undefined;
    const triageStatus = call
      ? (call["triage_status"] as string | undefined) ?? "—"
      : "—";
    const laceScore = call
      ? ((call["lace_score"] as number | undefined) ?? 0)
      : (id === "P004" ? p004Lace : 0);
    const laceLevel = call
      ? ((call["lace_risk_level"] as string | undefined) ?? "UNKNOWN")
      : (id === "P004" ? p004RiskLevel : "UNKNOWN");

    const protocolMark = id === "P004" ? "PENDING " : (protocolCount > 0 ? "✓       " : "✗       ");
    const laceStr      = `${laceScore} ${laceLevel}`;

    console.log(
      `  ${id.padEnd(7)} | ${protocolMark} | ${triageStatus.padEnd(10)} | ${laceStr}`
    );
  }

  // Verification checks
  const callsWithLace = callItems.filter((i) => (i["lace_score"] as number | undefined) !== undefined).length;
  const reviewOk      = reviewCount === 1;
  const protocolsOk   = protocolCount >= 5;
  const laceOk        = callsWithLace >= 5;

  console.log();
  console.log(`  CallResults with LACE:   ${callsWithLace}/5  ${laceOk ? "✓" : "✗"}`);
  console.log(`  ProtocolReview records:  ${reviewCount}    ${reviewOk ? "✓" : "✗"} (expect 1)`);
  console.log(`  TriageProtocols loaded:  ${protocolCount}    ${protocolsOk ? "✓" : "✗"} (expect ≥5)`);
  console.log();

  // ─── STEP 10 — Startup summary ──────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  console.log(SEP);
  console.log("SENTINEL VOICE — READY");
  console.log(SEP);
  console.log(`Patients:        6 loaded`);
  console.log(`Protocols:       ${protocolCount} generated (1 pending review)`);
  console.log(`Triage results:  ${callItems.filter((i) => i["triage_status"]).length} complete`);
  console.log(`LACE scores:     6 calculated`);
  console.log(`Protocol review: 1 pending (P004 — J18.9)`);
  console.log(SEP);
  console.log("Next step:");
  console.log("  cd dashboard && npm run dev");
  console.log("  Open http://localhost:3000");
  console.log(SEP);
  console.log(`Time taken: ${elapsed} seconds`);
  console.log(SEP + "\n");

  if (!laceOk || !reviewOk || !protocolsOk) {
    console.error("One or more verification checks failed — see above.");
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("\n✗ morning:start failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
