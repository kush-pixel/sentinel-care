/**
 * test-real-call.ts — Places a real outbound call to test the full Nova Sonic
 * pipeline end-to-end.
 *
 * Prerequisites:
 *   1. Set TEST_PHONE_NUMBER in .env (e.g. +18722883249)
 *   2. Ensure morning:start has been run (P001 protocol must exist)
 *   3. Lambda sentinel-call-initiator must be deployed
 *
 * Run: cd scripts && npm run test:real-call
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import fetch from "node-fetch";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { generateCallId } from "@sentinel/validation";

const SEP = "─────────────────────────────────────────────";
const FHIR_BASE   = process.env["FHIR_BASE_URL"] ?? "http://44.198.181.68:8080/fhir";
const REGION      = process.env["AWS_REGION"]    ?? "us-east-1";
const PATIENT_ID  = "P001";
const LAMBDA_NAME = "sentinel-call-initiator";

// ─── FHIR types ───────────────────────────────────────────────────────────────

interface FhirTelecom {
  system: string;
  value:  string;
  use:    string;
}

interface FhirPatient {
  resourceType: string;
  id:           string;
  telecom?:     FhirTelecom[];
  [key: string]: unknown;
}

// ─── Step 1: Upsert test phone number on P001 ─────────────────────────────────

async function addPhoneToPatient(phoneNumber: string): Promise<void> {
  // GET existing resource
  const getRes = await fetch(`${FHIR_BASE}/Patient/${PATIENT_ID}`);
  if (!getRes.ok) {
    throw new Error(`FHIR GET Patient/${PATIENT_ID} failed: ${getRes.status}`);
  }
  const patient = (await getRes.json()) as FhirPatient;

  // Replace or add telecom entry for phone
  const otherTelecoms = (patient.telecom ?? []).filter((t) => t.system !== "phone");
  const updated: FhirPatient = {
    ...patient,
    telecom: [
      ...otherTelecoms,
      { system: "phone", value: phoneNumber, use: "mobile" },
    ],
  };

  // PUT updated resource
  const putRes = await fetch(`${FHIR_BASE}/Patient/${PATIENT_ID}`, {
    method:  "PUT",
    headers: { "Content-Type": "application/fhir+json" },
    body:    JSON.stringify(updated),
  });
  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`FHIR PUT Patient/${PATIENT_ID} failed ${putRes.status}: ${body.slice(0, 200)}`);
  }
}

// ─── Step 2: Invoke call-initiator Lambda ────────────────────────────────────

interface CallInitiatorResponse {
  statusCode: number;
  contactId?: string;
  callId?:    string;
  patientId?: string;
  status?:    string;
  error?:     string;
}

async function invokeCallInitiator(callId: string): Promise<CallInitiatorResponse> {
  const client  = new LambdaClient({ region: REGION });
  const payload = JSON.stringify({ patientId: PATIENT_ID, callId });

  const resp = await client.send(new InvokeCommand({
    FunctionName:   LAMBDA_NAME,
    Payload:        Buffer.from(payload),
    InvocationType: "RequestResponse",
  }));

  if (resp.FunctionError) {
    const errBody = resp.Payload ? Buffer.from(resp.Payload).toString("utf8") : "no payload";
    throw new Error(`Lambda function error: ${errBody}`);
  }

  if (!resp.Payload) {
    throw new Error("Lambda returned no payload");
  }

  return JSON.parse(Buffer.from(resp.Payload).toString("utf8")) as CallInitiatorResponse;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(SEP);
  console.log("SENTINEL — REAL CALL TEST");
  console.log(SEP + "\n");

  // Validate TEST_PHONE_NUMBER
  const testPhone = process.env["TEST_PHONE_NUMBER"];
  if (!testPhone) {
    console.error("TEST_PHONE_NUMBER is not set.");
    console.error("Add it to your .env file:");
    console.error("  TEST_PHONE_NUMBER=+1XXXXXXXXXX");
    process.exit(1);
  }

  const callId = generateCallId();

  console.log(`  Patient:  ${PATIENT_ID}`);
  console.log(`  Phone:    ${testPhone}`);
  console.log(`  Call ID:  ${callId}\n`);

  // Step 1 — Add phone to FHIR
  console.log("STEP 1 — Adding test phone number to P001 FHIR record...");
  await addPhoneToPatient(testPhone);
  console.log(`  ✓ PUT /fhir/Patient/${PATIENT_ID} with telecom phone=${testPhone}`);

  // Step 2 — Invoke call-initiator
  console.log("\nSTEP 2 — Invoking sentinel-call-initiator Lambda...");
  const result = await invokeCallInitiator(callId);

  if (result.statusCode !== 200) {
    throw new Error(`call-initiator returned ${result.statusCode}: ${result.error ?? "unknown error"}`);
  }

  console.log(`  ✓ Lambda responded: statusCode=${result.statusCode}`);
  console.log(`  ✓ Contact ID: ${result.contactId ?? "n/a"}`);
  console.log(`  ✓ Status: ${result.status ?? "n/a"}`);

  // Summary
  console.log("\n" + SEP);
  console.log("CALL INITIATED");
  console.log(SEP);
  console.log(`  ✓ Call initiated for ${PATIENT_ID}`);
  console.log(`  ✓ Phone: ${testPhone}`);
  console.log(`  ✓ Call ID: ${callId}`);
  console.log(`  ✓ Watch your phone for an incoming call from +17208446427`);
  console.log(`  ✓ Check the dashboard after the call completes`);
  console.log(SEP);
}

main().catch((err: unknown) => {
  console.error("test:real-call failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
