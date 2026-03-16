/**
 * test-p002-call.ts — Places a real outbound call to P002 (Robert Chen, Z96.651)
 * to verify the full pipeline works for a knee-replacement patient.
 *
 * Steps:
 *   1. Fetch P002 FHIR record + PatientProfile
 *   2. Add TEST_PHONE_NUMBER to FHIR
 *   3. Verify protocol exists in TriageProtocols (auto-generate if missing)
 *   4. Invoke sentinel-call-initiator
 *   5. Print call summary and STOP — user confirms call ended before audit runs
 *
 * Run: cd scripts && npm run test:p002-call
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import fetch from "node-fetch";
import {
  LambdaClient,
  InvokeCommand,
} from "@aws-sdk/client-lambda";
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { generateCallId } from "@sentinel/validation";

const SEP  = "═══════════════════════════════════════════════════════";
const SEP2 = "───────────────────────────────────────────────────────";
const PATIENT_ID  = "P002";
const REGION      = process.env["AWS_REGION"]    ?? "us-east-1";
const FHIR_BASE   = process.env["FHIR_BASE_URL"] ?? "http://44.198.181.68:8080/fhir";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FhirTelecom { system: string; value: string; use: string }
interface FhirPatient { resourceType: string; id: string; telecom?: FhirTelecom[]; [k: string]: unknown }

interface ProtocolCondition {
  variable: string; operator: string; threshold: number | boolean; weight: number; flag_color: string;
}
interface Protocol {
  flag_color: string; question_priority: string[];
  root_node: { conditions: ProtocolCondition[] };
}
interface ProtocolItem { protocol?: Protocol; review_status?: string }

interface ProfileItem {
  patient_name?: string; condition_code?: string; condition_display?: string;
  lace_score?: number; lace_risk_level?: string;
}

interface CallInitiatorResponse {
  statusCode: number; contactId?: string; callId?: string; status?: string; error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const lambda = new LambdaClient({ region: REGION });

async function getFhirPatient(): Promise<FhirPatient> {
  const res = await fetch(`${FHIR_BASE}/Patient/${PATIENT_ID}`);
  if (!res.ok) throw new Error(`FHIR GET Patient/${PATIENT_ID} failed: ${res.status}`);
  return await res.json() as FhirPatient;
}

async function addPhoneToFhir(phoneNumber: string): Promise<void> {
  const patient = await getFhirPatient();
  const others  = (patient.telecom ?? []).filter(t => t.system !== "phone");
  const updated: FhirPatient = {
    ...patient,
    telecom: [...others, { system: "phone", value: phoneNumber, use: "mobile" }],
  };
  const res = await fetch(`${FHIR_BASE}/Patient/${PATIENT_ID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(updated),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FHIR PUT Patient/${PATIENT_ID} failed ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function getProfile(): Promise<ProfileItem> {
  const r = await dynamo.send(new GetCommand({ TableName: "PatientProfiles", Key: { patient_id: PATIENT_ID } }));
  return (r.Item ?? {}) as ProfileItem;
}

async function getProtocol(): Promise<ProtocolItem | null> {
  const r = await dynamo.send(new GetCommand({ TableName: "TriageProtocols", Key: { patient_id: PATIENT_ID } }));
  return r.Item ? (r.Item as ProtocolItem) : null;
}

async function generateProtocol(): Promise<void> {
  console.log("    Invoking sentinel-care-planner to generate P002 protocol...");
  const payload = JSON.stringify({ patientId: PATIENT_ID });
  const resp = await lambda.send(new InvokeCommand({
    FunctionName:   "sentinel-care-planner",
    InvocationType: "RequestResponse",
    Payload:        Buffer.from(payload),
  }));
  if (resp.FunctionError) {
    const errBody = resp.Payload ? Buffer.from(resp.Payload).toString("utf8") : "no payload";
    throw new Error(`care-planner error: ${errBody}`);
  }
  const result = resp.Payload
    ? JSON.parse(Buffer.from(resp.Payload).toString("utf8")) as { statusCode?: number; error?: string }
    : {};
  if (result.statusCode && result.statusCode !== 200) {
    throw new Error(`care-planner returned ${result.statusCode}: ${result.error ?? "unknown"}`);
  }
}

async function invokeCallInitiator(callId: string): Promise<CallInitiatorResponse> {
  const payload = JSON.stringify({ patientId: PATIENT_ID, callId });
  const resp = await lambda.send(new InvokeCommand({
    FunctionName:   "sentinel-call-initiator",
    InvocationType: "RequestResponse",
    Payload:        Buffer.from(payload),
  }));
  if (resp.FunctionError) {
    const errBody = resp.Payload ? Buffer.from(resp.Payload).toString("utf8") : "no payload";
    throw new Error(`call-initiator error: ${errBody}`);
  }
  if (!resp.Payload) throw new Error("call-initiator returned no payload");
  return JSON.parse(Buffer.from(resp.Payload).toString("utf8")) as CallInitiatorResponse;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n" + SEP);
  console.log("  SENTINEL — P002 REAL CALL TEST");
  console.log(SEP + "\n");

  const testPhone = process.env["TEST_PHONE_NUMBER"];
  if (!testPhone) {
    console.error("  ERROR: TEST_PHONE_NUMBER not set in .env");
    process.exit(1);
  }

  // ── STEP 1 — Fetch P002 profile ─────────────────────────────────────────────
  console.log("STEP 1 — Loading P002 patient data...");
  const profile = await getProfile();

  const patientName      = profile.patient_name      ?? "Unknown";
  const conditionCode    = profile.condition_code    ?? "UNKNOWN";
  const conditionDisplay = profile.condition_display ?? conditionCode;
  const laceScore        = profile.lace_score        ?? 0;
  const laceRiskLevel    = profile.lace_risk_level   ?? "UNKNOWN";

  console.log(`  Patient:    ${patientName} (${PATIENT_ID})`);
  console.log(`  Condition:  ${conditionCode} — ${conditionDisplay}`);
  console.log(`  LACE:       ${laceScore} ${laceRiskLevel}`);

  // ── STEP 2 — Add phone to FHIR ─────────────────────────────────────────────
  console.log("\nSTEP 2 — Adding test phone number to FHIR...");
  await addPhoneToFhir(testPhone);
  console.log(`  ✓ Phone ${testPhone} written to FHIR Patient/${PATIENT_ID}`);

  // ── STEP 3 — Verify / generate protocol ────────────────────────────────────
  console.log("\nSTEP 3 — Verifying triage protocol...");
  let protocolItem = await getProtocol();

  if (!protocolItem?.protocol) {
    console.log("  No protocol found — generating via sentinel-care-planner...");
    await generateProtocol();
    // Reload after generation
    protocolItem = await getProtocol();
    if (!protocolItem?.protocol) {
      throw new Error("Protocol generation failed — TriageProtocols still empty for P002");
    }
    console.log("  ✓ Protocol generated");
  }

  const proto = protocolItem.protocol as Protocol;
  const questions = proto.question_priority ?? [];

  console.log(`  ✓ Protocol found — ${questions.length} questions:`);
  questions.forEach((v, i) => {
    const cond = proto.root_node?.conditions?.find(c => c.variable === v);
    const rule = cond ? `${v} ${cond.operator} ${cond.threshold}` : v;
    console.log(`    Q${i + 1}: ${rule} (flag: ${cond?.flag_color ?? "?"})`);
  });

  // ── STEP 4 — Place the call ─────────────────────────────────────────────────
  console.log("\nSTEP 4 — Placing call via sentinel-call-initiator...");
  const callId = generateCallId();
  const result = await invokeCallInitiator(callId);

  if (result.statusCode !== 200) {
    throw new Error(`call-initiator returned ${result.statusCode}: ${result.error ?? "unknown"}`);
  }

  console.log(`  ✓ Call initiated (contactId: ${result.contactId ?? "n/a"})`);

  // ── STEP 5 — Instructions ───────────────────────────────────────────────────
  console.log("\n" + SEP);
  console.log(`  REAL CALL — ${patientName} (${PATIENT_ID})`);
  console.log(`  Condition: ${conditionCode} — ${conditionDisplay}`);
  console.log(`  Phone: ${testPhone}`);
  console.log(`  Call ID: ${callId}`);
  console.log(SEP2);
  console.log("  Expected questions:");
  questions.forEach((v, i) => {
    const cond = proto.root_node?.conditions?.find(c => c.variable === v);
    const hint =
      v === "fever"                ? `  Temperature ≥ ${cond?.threshold ?? 101}°F?`   :
      v === "wound_drainage"       ? "  Drainage/discharge from incision?"             :
      v === "pain_level"           ? `  Pain ≥ ${cond?.threshold ?? 7}/10?`            :
      v === "mobility"             ? "  Able to move / walk as expected?"              :
      v === "medication_adherence" ? "  Taking all meds as prescribed?"                :
      `  ${v.replace(/_/g, " ")}`;
    console.log(`    Q${i + 1} — ${v}${hint}`);
  });
  console.log(SEP2);
  console.log("  Answer naturally. Incoming call from +17208446427");
  console.log(SEP2);
  console.log(`  After call ends, run the audit:`);
  console.log(`    npm run post-call-audit -- ${PATIENT_ID} ${callId}`);
  console.log(SEP);
  console.log("  WAITING — Do not continue until the call has ended.\n");
}

main().catch((err: unknown) => {
  console.error("test:p002-call failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
