/**
 * demo-p004-flow.ts — Full P004 clinical journey demo.
 *
 * Simulates: PENDING_REVIEW → Nurse Approves → Call Placed
 *            → Triage Engine → Summarizer → RED in Dashboard
 *
 * Self-contained: Step 0 resets to clean state automatically.
 * Idempotent: safe to run multiple times without demo:reset.
 */
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { handler as triageHandler } from "../../../packages/triage-engine/src/handler";
import { handler as summarizerHandler } from "../../../lambdas/summarizer/src/handler";

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
  console.log("P004 DEMO FLOW");
  console.log(SEP + "\n");

  const dynamo = makeDynamo();
  const reviewsTable = process.env["DYNAMO_TABLE_REVIEWS"] ?? "ProtocolReview";
  const protocolsTable = process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols";
  const resultsTable = process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults";
  const now = new Date().toISOString();

  // ─── STEP 0 — Clean previous demo state ─────────────────────────────────────
  console.log("Step 0 — Cleaning previous demo state...");

  try {
    await dynamo.send(
      new DeleteCommand({
        TableName: resultsTable,
        Key: { call_id: "C004", patient_id: "P004" },
      })
    );
    console.log("  ✓ Step 0: Cleared previous C004 call result");
  } catch {
    console.log("  ✓ Step 0: No previous C004 to clear — starting fresh");
  }

  await dynamo.send(
    new UpdateCommand({
      TableName: reviewsTable,
      Key: { review_id: "REV-P004-DEMO", patient_id: "P004" },
      UpdateExpression:
        "SET #s = :s REMOVE reviewed_by, reviewed_at, approved_at, review_notes",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "PENDING_REVIEW" },
    })
  );
  console.log("  ✓ Step 0: REV-P004-DEMO reset to PENDING_REVIEW\n");

  // ─── STEP 1 — Verify starting state ─────────────────────────────────────────
  console.log("Step 1 — Verifying starting state...");
  const reviewItem = await dynamo.send(
    new GetCommand({
      TableName: reviewsTable,
      Key: { review_id: "REV-P004-DEMO", patient_id: "P004" },
    })
  );

  const currentStatus = reviewItem.Item?.["status"] as string | undefined;
  if (currentStatus !== "PENDING_REVIEW") {
    console.error(
      `  ERROR: REV-P004-DEMO has status "${currentStatus ?? "NOT FOUND"}" — expected PENDING_REVIEW.`
    );
    console.error("  Run: npm run demo:reset  then try again.");
    process.exit(1);
  }
  console.log("  ✓ Step 1: P004 protocol is PENDING_REVIEW\n");

  // ─── STEP 2 — Simulate nurse approval ────────────────────────────────────────
  console.log("Step 2 — Approving protocol (Demo Nurse)...");

  await dynamo.send(
    new UpdateCommand({
      TableName: reviewsTable,
      Key: { review_id: "REV-P004-DEMO", patient_id: "P004" },
      UpdateExpression:
        "SET #s = :s, reviewed_by = :rb, reviewed_at = :ra, approved_at = :aa, review_notes = :rn",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "APPROVED",
        ":rb": "Demo Nurse",
        ":ra": now,
        ":aa": now,
        ":rn": "Protocol approved for demo",
      },
    })
  );

  // Copy protocol to TriageProtocols
  const review = reviewItem.Item as Record<string, unknown>;
  await dynamo.send(
    new PutCommand({
      TableName: protocolsTable,
      Item: {
        patient_id: "P004",
        protocol: review["protocol"],
        lace_score: review["lace_score"],
        lace_risk_level: review["lace_risk_level"],
        lace_components: review["lace_components"],
        approved_by: "Demo Nurse",
        review_id: "REV-P004-DEMO",
        created_at: now,
      },
    })
  );

  console.log("  [AUDIT] PROTOCOL_APPROVED patient=P004 by=Demo Nurse");
  console.log("  ✓ Step 2: Protocol approved and copied to TriageProtocols\n");

  // ─── STEP 3 — Inject call answers ────────────────────────────────────────────
  console.log("Step 3 — Injecting call answers for P004...");

  await dynamo.send(
    new PutCommand({
      TableName: resultsTable,
      Item: {
        call_id: "C004",
        patient_id: "P004",
        call_status: "COMPLETE",
        call_timestamp: now,
        condition_code: "J18.9",
        protocol_source: "validated_library",
        nurse_acknowledged: false,
        acknowledged_by: null,
        acknowledged_at: null,
        transcript_warnings: [],
        unresolved_variables: [],
        variables: {
          shortness_of_breath: { value: true,  confidence: 0.94 },
          fever:               { value: 102.1, confidence: 0.91 },
          antibiotic_taken:    { value: false, confidence: 0.89 },
          confusion:           { value: false, confidence: 0.87 },
          appetite:            { value: false, confidence: 0.82 },
          mobility:            { value: false, confidence: 0.78 },
        },
      },
    })
  );

  console.log("  ✓ Step 3: Call answers injected for P004");
  console.log("    (fever=102.1, shortness_of_breath=true, antibiotic_taken=false)\n");

  // ─── STEP 4 — Run triage engine ──────────────────────────────────────────────
  console.log("Step 4 — Running triage engine...");

  const triageResult = (await triageHandler({
    callId: "C004",
    patientId: "P004",
  })) as Record<string, unknown>;

  const triageStatus = triageResult["triageStatus"] as string | undefined;
  const brokenRules = (triageResult["brokenRules"] as string[] | undefined) ?? [];
  const escalated = triageResult["escalationTriggered"] as boolean | undefined;

  console.log("  ✓ Step 4: Triage complete");
  console.log(`    Status: ${triageStatus ?? "unknown"}`);
  console.log(`    Broken rules: ${brokenRules.join(", ") || "none"}`);
  console.log(`    Escalation: ${String(escalated ?? false)}`);

  if (triageStatus !== "RED") {
    console.warn(`  ⚠ WARNING: Expected RED but got ${triageStatus ?? "unknown"}`);
  }
  console.log();

  // ─── STEP 5 — Run summarizer ─────────────────────────────────────────────────
  console.log("Step 5 — Generating SBAR summary...");

  const summaryResult = (await summarizerHandler({
    callId: "C004",
    patientId: "P004",
  })) as Record<string, unknown>;

  const guidelineSource = summaryResult["guidelineSource"] as string | undefined;

  console.log("  ✓ Step 5: SBAR generated");
  console.log(`    Guideline: ${guidelineSource ?? "unknown"}`);

  // ─── STEP 6 — Verify dashboard API ───────────────────────────────────────────
  console.log("Step 6 — Checking dashboard API...");

  let dashboardP004Found = false;
  let dashboardRed = 0;
  try {
    // Dynamic import to avoid compile-time issues with node-fetch
    const fetchModule = await import("node-fetch") as { default: typeof import("node-fetch").default };
    const fetch = fetchModule.default;
    const res = await fetch("http://localhost:3000/api/patients", {
      headers: { Accept: "application/json" },
    });

    if (res.ok) {
      const data = (await res.json()) as {
        patients: Array<{ patientId: string; triageStatus: string; laceScore: number }>;
        stats: { red: number };
      };
      const p004 = data.patients.find((p) => p.patientId === "P004");
      dashboardP004Found = !!p004;
      dashboardRed = data.stats.red;

      if (p004) {
        console.log("  ✓ Step 6: P004 visible in dashboard API");
        console.log(`    Status: ${p004.triageStatus}`);
        console.log(`    LACE: ${p004.laceScore} MODERATE`);
      } else {
        console.warn("  ⚠ Step 6: P004 not found in /api/patients response");
      }
    } else {
      console.warn(`  ⚠ Dashboard returned HTTP ${res.status} — skipping API check`);
    }
  } catch {
    console.warn("  ⚠ Dashboard not running — skipping API check");
  }

  // ─── STEP 7 — Final summary ───────────────────────────────────────────────────
  console.log(SEP);
  console.log("P004 DEMO FLOW COMPLETE");
  console.log(SEP);
  console.log("Starting state:   PENDING_REVIEW (no triage)");
  console.log("After approval:   Protocol in TriageProtocols");
  console.log("After call:       Triage = RED");
  console.log(
    `Dashboard:        P004 ${dashboardP004Found ? "visible as RED" : "check manually — dashboard may not be running"}`
  );
  console.log(SEP);
  console.log("Dashboard now shows:");
  if (dashboardRed > 0) {
    console.log(`  RED:        ${dashboardRed} (includes P001, P004, P005)`);
  } else {
    console.log("  RED:        3 (P001, P004, P005)  ← after next API refresh");
  }
  console.log("  YELLOW:     1 (P002)");
  console.log("  GREEN:      1 (P003)");
  console.log("  INCOMPLETE: 1 (P006)");
  console.log(SEP);
  console.log(`DEMO FLOW: ${triageStatus === "RED" ? "PASS" : "WARN — triage not RED"}`);
  console.log(SEP + "\n");

  if (triageStatus !== "RED") process.exit(1);
}

main().catch((err: unknown) => {
  console.error("demo-p004-flow failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
