/**
 * hydrate-lace.ts — Calculate LACE scores from FHIR and write to PatientProfiles.
 *
 * Reads ALL patients from FHIR, calculates LACE using @sentinel/lace,
 * and writes results to PatientProfiles DynamoDB table.
 *
 * Idempotent: safe to run multiple times (UpdateCommand overwrites).
 * Run BEFORE seed:demo so seed scripts can read from PatientProfiles.
 */
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import fetch from "node-fetch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { calculateLaceScore } from "@sentinel/lace";
import {
  getFullPatientRecord,
  FhirBundle,
  FhirPatient,
} from "../fhir/fhir-client";

function makeDynamo(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  });
  return DynamoDBDocumentClient.from(raw);
}

function fhirBase(): string {
  const url = process.env["FHIR_BASE_URL"];
  if (!url) throw new Error("FHIR_BASE_URL is not set");
  return url;
}

const SEP = "─────────────────────────────────────────────────────────────────";

async function main(): Promise<void> {
  console.log(SEP);
  console.log("LACE HYDRATION — PatientProfiles from FHIR");
  console.log(SEP + "\n");

  const dynamo = makeDynamo();
  const patientsTable = process.env["DYNAMO_TABLE_PATIENTS"] ?? "PatientProfiles";
  const now = new Date().toISOString();

  // ─── STEP 1 — Fetch all patients from FHIR ─────────────────────────────────
  console.log("Step 1 — Fetching all patients from FHIR...");
  const res = await fetch(`${fhirBase()}/Patient`);
  if (!res.ok) {
    throw new Error(`FHIR /Patient fetch failed: ${res.status} ${res.statusText}`);
  }
  const bundle = (await res.json()) as FhirBundle<FhirPatient>;
  const patients = (bundle.entry ?? []).map((e) => e.resource);
  console.log(`  Found ${patients.length} patient(s) in FHIR\n`);

  if (patients.length === 0) {
    console.warn("  ⚠ No patients found in FHIR — run seed:fhir first.");
    return;
  }

  // ─── STEP 2 — Calculate LACE and write to PatientProfiles ──────────────────
  console.log("Step 2 — Calculating LACE and writing to PatientProfiles...\n");

  const rows: Array<{
    patientId: string;
    L: number;
    A: number;
    C: number;
    E: number;
    total: number;
    risk: string;
    status: string;
  }> = [];

  for (const patient of patients) {
    const patientId = patient.id;
    try {
      const record = await getFullPatientRecord(patientId);
      const conditionCodes = record.conditions
        .flatMap((c) => c.code.coding)
        .map((coding) => coding.code)
        .filter((code): code is string => !!code);

      const lace = calculateLaceScore({
        admissionDate: record.encounterSummary.admissionDate,
        dischargeDate: record.encounterSummary.dischargeDate,
        admissionType: record.encounterSummary.admissionType,
        conditionCodes,
        recentEDVisits: record.encounterSummary.recentEDVisits,
      });

      await dynamo.send(
        new UpdateCommand({
          TableName: patientsTable,
          Key: { patient_id: patientId },
          UpdateExpression: [
            "SET lace_score              = :ls",
            "    lace_risk_level         = :lr",
            "    lace_components         = :lc",
            "    lace_length_of_stay_days = :ld",
            "    lace_charlson_score     = :cs",
            "    lace_interpretation     = :li",
            "    lace_calculated_at      = :la",
          ].join(", "),
          ExpressionAttributeValues: {
            ":ls": lace.totalScore,
            ":lr": lace.riskLevel,
            ":lc": lace.components,
            ":ld": lace.lengthOfStayDays,
            ":cs": lace.charlsonScore,
            ":li": lace.interpretation,
            ":la": now,
          },
        })
      );

      rows.push({
        patientId,
        L: lace.components.L,
        A: lace.components.A,
        C: lace.components.C,
        E: lace.components.E,
        total: lace.totalScore,
        risk: lace.riskLevel,
        status: "✓",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠ ${patientId}: LACE calculation failed — ${msg}`);
      rows.push({ patientId, L: 0, A: 0, C: 0, E: 0, total: 0, risk: "ERROR", status: "✗" });
    }
  }

  // ─── STEP 3 — Print verification table ────────────────────────────────────
  console.log(SEP);
  console.log("LACE SCORE REPORT — PatientProfiles");
  console.log(SEP);
  console.log(
    "Patient | L | A | C | E | Total | Risk       | Status"
  );
  console.log(SEP);

  for (const r of rows) {
    const total = String(r.total).padStart(5);
    const risk  = r.risk.padEnd(10);
    console.log(
      `${r.patientId.padEnd(7)} | ${r.L} | ${r.A} | ${r.C} | ${r.E} |${total} | ${risk} | ${r.status}`
    );
  }

  console.log(SEP);

  const passed = rows.filter((r) => r.status === "✓").length;
  const failed = rows.filter((r) => r.status === "✗").length;
  console.log(`\nHydrated: ${passed}/${rows.length} patients`);
  if (failed > 0) {
    console.warn(`⚠ ${failed} patient(s) failed — check FHIR data.`);
    process.exit(1);
  }
  console.log("PatientProfiles hydrated successfully.\n");
}

main().catch((err: unknown) => {
  console.error(
    "hydrate-lace failed:",
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});
