/**
 * cleanup-p008.ts — Full teardown of P008 test data.
 *
 * Deletes (in safe dependency order):
 *   1. CallResults       — all records where patient_id = "P008"
 *   2. ProtocolReview    — all records where patient_id = "P008"
 *   3. TriageProtocols   — patient_id = "P008"
 *   4. PatientProfiles   — patient_id = "P008"
 *   5. FHIR Conditions   — all resources referencing Patient/P008
 *   6. FHIR Encounters   — all resources referencing Patient/P008
 *   7. FHIR MedicationRequests — all resources referencing Patient/P008
 *   8. FHIR Patient/P008
 *
 * Run: cd scripts && npm run cleanup:p008
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import fetch from "node-fetch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const PATIENT_ID = "P008";
const SEP        = "─────────────────────────────────────────────";
const REGION     = process.env["AWS_REGION"]            ?? "us-east-1";

const TABLE_RESULTS   = process.env["DYNAMO_TABLE_RESULTS"]   ?? "CallResults";
const TABLE_REVIEWS   = process.env["DYNAMO_TABLE_REVIEWS"]   ?? "ProtocolReview";
const TABLE_PROTOCOLS = process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols";
const TABLE_PATIENTS  = process.env["DYNAMO_TABLE_PATIENTS"]  ?? "PatientProfiles";

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: REGION,
    ...(process.env["DYNAMO_ENDPOINT"] && { endpoint: process.env["DYNAMO_ENDPOINT"] }),
  })
);

function fhirBase(): string {
  return process.env["FHIR_BASE_URL"] ?? "http://3.239.230.36:8080/fhir";
}

// ─── DynamoDB helpers ─────────────────────────────────────────────────────────

/** Scan a table for all records where patient_id = PATIENT_ID, return keys. */
async function scanKeys(
  table: string,
  pkField: string,
  skField?: string,
): Promise<Array<Record<string, string>>> {
  const keys: Array<Record<string, string>> = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const resp = await dynamo.send(new ScanCommand({
      TableName:                 table,
      FilterExpression:          "patient_id = :pid",
      ExpressionAttributeValues: { ":pid": PATIENT_ID },
      ExclusiveStartKey:         lastKey,
    }));

    for (const item of resp.Items ?? []) {
      const key: Record<string, string> = {
        [pkField]: String(item[pkField] ?? ""),
      };
      if (skField) key[skField] = String(item[skField] ?? "");
      keys.push(key);
    }

    lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return keys;
}

async function deleteFromTable(
  table: string,
  keys: Array<Record<string, string>>,
  label: string,
): Promise<void> {
  if (keys.length === 0) {
    console.log(`  (no ${label} records found)`);
    return;
  }
  for (const key of keys) {
    await dynamo.send(new DeleteCommand({ TableName: table, Key: key }));
    const keyStr = Object.entries(key).map(([k, v]) => `${k}=${v}`).join(", ");
    console.log(`  ✓ DELETE ${label} / ${keyStr}`);
  }
}

// ─── FHIR helpers ─────────────────────────────────────────────────────────────

async function deleteFhirResource(resourceType: string, id: string): Promise<void> {
  const res = await fetch(`${fhirBase()}/${resourceType}/${id}`, { method: "DELETE" });
  const ok = res.status === 200 || res.status === 204 || res.status === 404;
  console.log(`  ${ok ? "✓" : "✗"} DELETE /fhir/${resourceType}/${id} → ${res.status}`);
  if (!ok) throw new Error(`Unexpected status ${res.status} deleting ${resourceType}/${id}`);
}

async function searchReferencing(resourceType: string): Promise<string[]> {
  const url = `${fhirBase()}/${resourceType}?patient=${PATIENT_ID}&_elements=id`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const bundle = (await res.json()) as { entry?: { resource?: { id?: string } }[] };
    return (bundle.entry ?? []).map((e) => e.resource?.id ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

async function deleteAllReferencing(resourceType: string): Promise<void> {
  const ids = await searchReferencing(resourceType);
  if (ids.length === 0) {
    console.log(`  (no /fhir/${resourceType}?patient=${PATIENT_ID} found)`);
    return;
  }
  for (const id of ids) {
    await deleteFhirResource(resourceType, id);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(SEP);
  console.log(`SENTINEL — CLEANUP ${PATIENT_ID} TEST DATA`);
  console.log(SEP + "\n");

  // ── STEP 1: DynamoDB CallResults ────────────────────────────────────────────
  console.log(`[1/8] CallResults (${TABLE_RESULTS})`);
  const callKeys = await scanKeys(TABLE_RESULTS, "call_id", "patient_id");
  await deleteFromTable(TABLE_RESULTS, callKeys, "CallResults");

  // ── STEP 2: DynamoDB ProtocolReview ─────────────────────────────────────────
  console.log(`\n[2/8] ProtocolReview (${TABLE_REVIEWS})`);
  const reviewKeys = await scanKeys(TABLE_REVIEWS, "review_id", "patient_id");
  await deleteFromTable(TABLE_REVIEWS, reviewKeys, "ProtocolReview");

  // ── STEP 3: DynamoDB TriageProtocols ────────────────────────────────────────
  console.log(`\n[3/8] TriageProtocols (${TABLE_PROTOCOLS})`);
  await dynamo.send(new DeleteCommand({
    TableName: TABLE_PROTOCOLS,
    Key: { patient_id: PATIENT_ID },
  }));
  console.log(`  ✓ DELETE TriageProtocols / patient_id=${PATIENT_ID}`);

  // ── STEP 4: DynamoDB PatientProfiles ────────────────────────────────────────
  console.log(`\n[4/8] PatientProfiles (${TABLE_PATIENTS})`);
  await dynamo.send(new DeleteCommand({
    TableName: TABLE_PATIENTS,
    Key: { patient_id: PATIENT_ID },
  }));
  console.log(`  ✓ DELETE PatientProfiles / patient_id=${PATIENT_ID}`);

  // ── STEP 5–7: FHIR referencing resources ────────────────────────────────────
  console.log(`\n[5/8] FHIR Conditions`);
  await deleteAllReferencing("Condition");

  console.log(`\n[6/8] FHIR Encounters`);
  await deleteAllReferencing("Encounter");

  console.log(`\n[7/8] FHIR MedicationRequests`);
  await deleteAllReferencing("MedicationRequest");

  // ── STEP 8: FHIR Patient ────────────────────────────────────────────────────
  console.log(`\n[8/8] FHIR Patient/${PATIENT_ID}`);
  await deleteFhirResource("Patient", PATIENT_ID);

  // ── Verification ────────────────────────────────────────────────────────────
  console.log("\nVerifying...");

  const reviewCheck = await scanKeys(TABLE_REVIEWS, "review_id", "patient_id");
  console.log(`  ${reviewCheck.length === 0 ? "✓" : "✗"} ProtocolReview: ${reviewCheck.length} records remaining`);

  const callCheck = await scanKeys(TABLE_RESULTS, "call_id", "patient_id");
  console.log(`  ${callCheck.length === 0 ? "✓" : "✗"} CallResults: ${callCheck.length} records remaining`);

  const profileCheck = await dynamo.send(new GetCommand({
    TableName: TABLE_PATIENTS,
    Key: { patient_id: PATIENT_ID },
  }));
  console.log(`  ${!profileCheck.Item ? "✓" : "✗"} PatientProfiles: ${!profileCheck.Item ? "not found" : "STILL PRESENT"}`);

  const fhirCheck = await fetch(`${fhirBase()}/Patient/${PATIENT_ID}`);
  const gone = fhirCheck.status === 404 || fhirCheck.status === 410;
  console.log(`  ${gone ? "✓" : "✗"} FHIR Patient/${PATIENT_ID}: ${fhirCheck.status} (${gone ? "gone" : "STILL PRESENT"})`);

  const allClean = reviewCheck.length === 0 && callCheck.length === 0 && !profileCheck.Item && gone;

  console.log("\n" + SEP);
  if (allClean) {
    console.log(`CLEANUP COMPLETE — ${PATIENT_ID} fully removed`);
  } else {
    console.error(`CLEANUP INCOMPLETE — some records still present`);
    process.exit(1);
  }
  console.log(SEP + "\n");
}

main().catch((err: unknown) => {
  console.error("cleanup:p008 failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
