/**
 * remove-test-patients.ts — Delete test patient P008 from FHIR and DynamoDB.
 *
 * Deletes:
 *   All FHIR Conditions referencing Patient/P008 (found via search)
 *   All FHIR Encounters referencing Patient/P008 (found via search)
 *   FHIR Patient/P008
 *   DynamoDB PatientProfiles → patient_id: "P008"
 *
 * Run: cd scripts && npm run remove:test-patients
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

process.env["AWS_REGION"]            = process.env["AWS_REGION"]            ?? "us-east-1";
process.env["FHIR_BASE_URL"]         = process.env["FHIR_BASE_URL"]         ?? "http://localhost:8080/fhir";
process.env["DYNAMO_TABLE_PATIENTS"] = process.env["DYNAMO_TABLE_PATIENTS"] ?? "PatientProfiles";

import fetch from "node-fetch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const SEP = "─────────────────────────────────────────────";

function fhirBase(): string {
  return process.env["FHIR_BASE_URL"] ?? "http://localhost:8080/fhir";
}

function makeDynamo(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"] && { endpoint: process.env["DYNAMO_ENDPOINT"] }),
  });
  return DynamoDBDocumentClient.from(raw);
}

// ─── FHIR helpers ─────────────────────────────────────────────────────────────

async function deleteFhirResource(resourceType: string, id: string): Promise<number> {
  const res = await fetch(`${fhirBase()}/${resourceType}/${id}`, { method: "DELETE" });
  return res.status;
}

async function getFhirStatus(resourceType: string, id: string): Promise<number> {
  const res = await fetch(`${fhirBase()}/${resourceType}/${id}`, { method: "GET" });
  return res.status;
}

/** Search for all resources of a type referencing a patient, return their IDs. */
async function searchReferencing(resourceType: string, patientId: string): Promise<string[]> {
  const url = `${fhirBase()}/${resourceType}?patient=${patientId}&_elements=id`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const bundle = (await res.json()) as { entry?: { resource?: { id?: string } }[] };
  return (bundle.entry ?? []).map((e) => e.resource?.id ?? "").filter(Boolean);
}

/** Delete all resources of a type referencing the patient, print each. */
async function deleteReferencing(resourceType: string, patientId: string): Promise<void> {
  const ids = await searchReferencing(resourceType, patientId);
  for (const id of ids) {
    const status = await deleteFhirResource(resourceType, id);
    if (status === 200 || status === 204 || status === 404) {
      console.log(`  ✓ DELETE /fhir/${resourceType}/${id} → ${status}`);
    } else {
      console.error(`  ✗ DELETE /fhir/${resourceType}/${id} → ${status} (unexpected)`);
      process.exit(1);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dynamo        = makeDynamo();
  const patientsTable = process.env["DYNAMO_TABLE_PATIENTS"] ?? "PatientProfiles";

  console.log(SEP);
  console.log("REMOVE TEST PATIENTS");
  console.log(SEP + "\n");

  // ─── Step 1: Delete referencing resources before Patient ─────────────────────
  // HAPI FHIR enforces referential integrity — Conditions and Encounters must be
  // removed before the Patient or the delete returns 409.

  console.log("Deleting FHIR resources referencing Patient/P008...");

  await deleteReferencing("Condition", "P008");
  await deleteReferencing("Encounter", "P008");

  // ─── Step 2: Delete Patient/P008 ─────────────────────────────────────────────

  const patientStatus = await deleteFhirResource("Patient", "P008");
  if (patientStatus === 200 || patientStatus === 204 || patientStatus === 404) {
    console.log(`  ✓ DELETE /fhir/Patient/P008 → ${patientStatus}`);
  } else {
    console.error(`  ✗ DELETE /fhir/Patient/P008 → ${patientStatus} (unexpected)`);
    process.exit(1);
  }

  // ─── Step 3: Delete from DynamoDB ────────────────────────────────────────────

  console.log("\nDeleting DynamoDB record...");

  await dynamo.send(
    new DeleteCommand({
      TableName: patientsTable,
      Key: { patient_id: "P008" },
    })
  );
  console.log(`  ✓ DELETE PatientProfiles / patient_id=P008`);

  // ─── Verification ─────────────────────────────────────────────────────────────

  console.log("\nVerifying deletions...");

  const fhirPatientCheck = await getFhirStatus("Patient", "P008");
  if (fhirPatientCheck === 404 || fhirPatientCheck === 410) {
    // 404 = never existed, 410 = existed and was deleted (HAPI FHIR returns 410)
    console.log(`  ✓ GET /fhir/Patient/P008 → ${fhirPatientCheck} (not found)`);
  } else {
    console.error(`  ✗ GET /fhir/Patient/P008 → ${fhirPatientCheck} (expected 404 or 410)`);
    process.exit(1);
  }

  const remainingConditions = await searchReferencing("Condition", "P008");
  if (remainingConditions.length === 0) {
    console.log(`  ✓ GET /fhir/Condition?patient=P008 → 0 remaining`);
  } else {
    console.error(`  ✗ ${remainingConditions.length} Condition(s) still reference P008`);
    process.exit(1);
  }

  const remainingEncounters = await searchReferencing("Encounter", "P008");
  if (remainingEncounters.length === 0) {
    console.log(`  ✓ GET /fhir/Encounter?patient=P008 → 0 remaining`);
  } else {
    console.error(`  ✗ ${remainingEncounters.length} Encounter(s) still reference P008`);
    process.exit(1);
  }

  const dynamoCheck = await dynamo.send(
    new GetCommand({ TableName: patientsTable, Key: { patient_id: "P008" } })
  );
  if (!dynamoCheck.Item) {
    console.log(`  ✓ GET PatientProfiles/P008 → not found`);
  } else {
    console.error(`  ✗ GET PatientProfiles/P008 → still present`);
    process.exit(1);
  }

  console.log("\n" + SEP);
  console.log("Done — P008 removed from FHIR and DynamoDB.");
  console.log(SEP + "\n");
}

main().catch((err: unknown) => {
  console.error("remove-test-patients failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
