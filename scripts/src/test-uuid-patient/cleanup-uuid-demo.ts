/**
 * cleanup-uuid-demo.ts — Reads .uuid-demo-ids.json and deletes all resources
 * created by seed-uuid-demo.ts: FHIR Patient/Condition/Encounter and all
 * DynamoDB records (PatientProfiles, TriageProtocols, CallResults, ProtocolReview).
 *
 * Run: cd scripts && npm run cleanup:uuid-demo
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

process.env["DYNAMO_ENDPOINT"]       = process.env["DYNAMO_ENDPOINT"]       ?? "http://localhost:8000";
process.env["AWS_REGION"]            = process.env["AWS_REGION"]            ?? "us-east-1";
process.env["FHIR_BASE_URL"]         = process.env["FHIR_BASE_URL"]         ?? "http://localhost:8080/fhir";
process.env["DYNAMO_TABLE_PROTOCOLS"] = process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols";
process.env["DYNAMO_TABLE_REVIEWS"]  = process.env["DYNAMO_TABLE_REVIEWS"]  ?? "ProtocolReview";
process.env["DYNAMO_TABLE_RESULTS"]  = process.env["DYNAMO_TABLE_RESULTS"]  ?? "CallResults";
process.env["DYNAMO_TABLE_PATIENTS"] = process.env["DYNAMO_TABLE_PATIENTS"] ?? "PatientProfiles";

import fetch from "node-fetch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

const IDS_FILE = path.resolve(__dirname, "../../../.uuid-demo-ids.json");
const SEP = "─────────────────────────────────────────────";

// ─── DynamoDB client ──────────────────────────────────────────────────────────

function makeDynamo(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region:   process.env["AWS_REGION"]      ?? "us-east-1",
    endpoint: process.env["DYNAMO_ENDPOINT"] ?? "http://localhost:8000",
  });
  return DynamoDBDocumentClient.from(raw);
}

function fhirBase(): string {
  return process.env["FHIR_BASE_URL"] ?? "http://localhost:8080/fhir";
}

// ─── FHIR helpers ─────────────────────────────────────────────────────────────

async function fhirDelete(resourceType: string, id: string): Promise<void> {
  const res = await fetch(`${fhirBase()}/${resourceType}/${id}`, { method: "DELETE" });
  // 200, 204 = deleted; 404, 410 = already gone — all acceptable in cleanup
  if (res.status >= 500) {
    console.warn(`  ⚠ DELETE /fhir/${resourceType}/${id} → ${res.status}`);
  }
}

async function fhirSearchIds(resourceType: string, patientId: string): Promise<string[]> {
  const res = await fetch(`${fhirBase()}/${resourceType}?patient=${patientId}&_elements=id`);
  if (!res.ok) return [];
  const bundle = (await res.json()) as { entry?: { resource?: { id?: string } }[] };
  return (bundle.entry ?? []).map((e) => e.resource?.id ?? "").filter(Boolean);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Read IDs file
  if (!fs.existsSync(IDS_FILE)) {
    console.error(`No .uuid-demo-ids.json found at ${IDS_FILE}`);
    console.error("Nothing to clean up — run 'npm run seed:uuid-demo' first.");
    process.exit(1);
  }

  const raw = fs.readFileSync(IDS_FILE, "utf8");
  const ids = JSON.parse(raw) as {
    patientId:        string;
    callId:           string;
    conditionCode:    string;
    conditionDisplay: string;
    triageStatus?:    string;
    createdAt:        string;
  };

  const { patientId, callId } = ids;

  console.log(SEP);
  console.log("UUID DEMO PATIENT — CLEANUP");
  console.log(SEP);
  console.log(`  patientId: ${patientId}`);
  console.log(`  callId:    ${callId}`);
  console.log(`  seeded at: ${ids.createdAt}\n`);

  const dynamo         = makeDynamo();
  const patientsTable  = process.env["DYNAMO_TABLE_PATIENTS"]  ?? "PatientProfiles";
  const protocolsTable = process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols";
  const resultsTable   = process.env["DYNAMO_TABLE_RESULTS"]   ?? "CallResults";
  const reviewsTable   = process.env["DYNAMO_TABLE_REVIEWS"]   ?? "ProtocolReview";

  // ─── Delete FHIR resources (referencing before Patient) ───────────────────
  console.log("Deleting FHIR resources...");

  const fhirConditions = await fhirSearchIds("Condition", patientId);
  const fhirEncounters = await fhirSearchIds("Encounter", patientId);

  for (const id of fhirConditions) {
    await fhirDelete("Condition", id);
    console.log(`  ✓ DELETE /fhir/Condition/${id}`);
  }
  for (const id of fhirEncounters) {
    await fhirDelete("Encounter", id);
    console.log(`  ✓ DELETE /fhir/Encounter/${id}`);
  }
  await fhirDelete("Patient", patientId);
  console.log(`  ✓ DELETE /fhir/Patient/${patientId}`);

  // ─── Delete DynamoDB records ───────────────────────────────────────────────
  console.log("\nDeleting DynamoDB records...");

  await dynamo.send(new DeleteCommand({ TableName: patientsTable,  Key: { patient_id: patientId } }));
  console.log(`  ✓ DELETE PatientProfiles/${patientId}`);

  await dynamo.send(new DeleteCommand({ TableName: protocolsTable, Key: { patient_id: patientId } }));
  console.log(`  ✓ DELETE TriageProtocols/${patientId}`);

  await dynamo.send(new DeleteCommand({ TableName: resultsTable, Key: { call_id: callId, patient_id: patientId } }));
  console.log(`  ✓ DELETE CallResults/${callId}`);

  // Scan ProtocolReview for this patientId (composite key — need to scan)
  const reviewScan = await dynamo.send(
    new ScanCommand({
      TableName:                 reviewsTable,
      FilterExpression:          "patient_id = :pid",
      ExpressionAttributeValues: { ":pid": patientId },
      ProjectionExpression:      "review_id, patient_id",
    })
  );
  for (const item of reviewScan.Items ?? []) {
    const rid = item["review_id"] as string;
    await dynamo.send(new DeleteCommand({ TableName: reviewsTable, Key: { review_id: rid, patient_id: patientId } }));
    console.log(`  ✓ DELETE ProtocolReview/${rid}`);
  }

  // ─── Remove IDs file ──────────────────────────────────────────────────────
  console.log("\nRemoving .uuid-demo-ids.json...");
  fs.unlinkSync(IDS_FILE);
  console.log(`  ✓ Deleted ${IDS_FILE}`);

  console.log("\n" + SEP);
  console.log("CLEANUP COMPLETE");
  console.log(SEP);
}

main().catch((err: unknown) => {
  console.error("cleanup:uuid-demo failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
