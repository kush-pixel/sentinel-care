/**
 * step0-seed.ts — Seed P007 (Eleanor Kim, COPD J44.1) into FHIR + DynamoDB.
 * Idempotent: skips FHIR resources that already return 200; skips DynamoDB
 * rule if condition_code J44.1 already exists.
 */
import * as dotenv from "dotenv";
import * as path from "path";
import fetch from "node-fetch";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { type ClinicalRule } from "@sentinel/schemas";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ─── FHIR helpers ─────────────────────────────────────────────────────────────

function fhirBase(): string {
  const url = process.env["FHIR_BASE_URL"];
  if (!url) throw new Error("FHIR_BASE_URL not set");
  return url;
}

async function putFhir(
  resourceType: string,
  id: string,
  body: object
): Promise<"PUT" | "SKIP" | "FAIL"> {
  // Check if already exists
  const check = await fetch(`${fhirBase()}/${resourceType}/${id}`);
  if (check.ok) return "SKIP";

  const res = await fetch(`${fhirBase()}/${resourceType}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(
      `  [${res.status}] PUT ${resourceType}/${id}:`,
      text.slice(0, 200)
    );
    return "FAIL";
  }
  return "PUT";
}

// ─── DynamoDB helper ──────────────────────────────────────────────────────────

function makeDynamo(): DynamoDBClient {
  return new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  });
}

// ─── P007 FHIR resources ──────────────────────────────────────────────────────

const P007_PATIENT = {
  resourceType: "Patient",
  id: "P007",
  name: [{ family: "Kim", given: ["Eleanor"] }],
  birthDate: "1955-08-14",
  gender: "female",
  communication: [
    { language: { coding: [{ system: "urn:ietf:bcp:47", code: "en" }] } },
  ],
  extension: [
    { url: "discharge-date", valueDate: "2026-03-10" },
    { url: "readmission-risk", valueString: "HIGH" },
    { url: "attending-physician", valueString: "Dr. Marcus Webb" },
  ],
};

const P007_CONDITION = {
  resourceType: "Condition",
  id: "COND-P007-1",
  subject: { reference: "Patient/P007" },
  code: {
    coding: [
      {
        system: "http://hl7.org/fhir/sid/icd-10",
        code: "J44.1",
        display: "COPD exacerbation",
      },
    ],
  },
  clinicalStatus: { coding: [{ code: "active" }] },
};

const P007_MEDICATIONS = [
  {
    resourceType: "MedicationRequest",
    id: "MED-P007-1",
    subject: { reference: "Patient/P007" },
    status: "active",
    intent: "order",
    medicationCodeableConcept: {
      coding: [
        {
          system: "http://www.nlm.nih.gov/research/umls/rxnorm",
          code: "435",
          display: "Albuterol inhaler 90mcg",
        },
      ],
    },
  },
  {
    resourceType: "MedicationRequest",
    id: "MED-P007-2",
    subject: { reference: "Patient/P007" },
    status: "active",
    intent: "order",
    medicationCodeableConcept: {
      coding: [
        {
          system: "http://www.nlm.nih.gov/research/umls/rxnorm",
          code: "41126",
          display: "Tiotropium 18mcg daily",
        },
      ],
    },
  },
  {
    resourceType: "MedicationRequest",
    id: "MED-P007-3",
    subject: { reference: "Patient/P007" },
    status: "active",
    intent: "order",
    medicationCodeableConcept: {
      coding: [
        {
          system: "http://www.nlm.nih.gov/research/umls/rxnorm",
          code: "8640",
          display: "Prednisone 40mg daily x5 days",
        },
      ],
    },
  },
];

const P007_ENCOUNTERS = [
  {
    id: "ENC-P007-ADMIT",
    body: {
      resourceType: "Encounter",
      id: "ENC-P007-ADMIT",
      status: "finished",
      class: { code: "IMP", display: "inpatient encounter" },
      type: [{ coding: [{ code: "EMER", display: "Emergency" }] }],
      subject: { reference: "Patient/P007" },
      period: { start: "2026-03-07T08:00:00Z", end: "2026-03-10T14:00:00Z" },
      hospitalization: {
        admitSource: {
          coding: [
            { code: "emd", display: "From accident/emergency department" },
          ],
        },
      },
    },
  },
  {
    id: "ENC-P007-ED-1",
    body: {
      resourceType: "Encounter",
      id: "ENC-P007-ED-1",
      status: "finished",
      class: { code: "EMER", display: "emergency" },
      subject: { reference: "Patient/P007" },
      period: {
        start: "2025-10-22T20:00:00Z",
        end: "2025-10-22T23:00:00Z",
      },
    },
  },
  {
    id: "ENC-P007-ED-2",
    body: {
      resourceType: "Encounter",
      id: "ENC-P007-ED-2",
      status: "finished",
      class: { code: "EMER", display: "emergency" },
      subject: { reference: "Patient/P007" },
      period: {
        start: "2026-01-15T14:00:00Z",
        end: "2026-01-15T17:00:00Z",
      },
    },
  },
];

// ─── COPD J44.1 clinical rule ─────────────────────────────────────────────────

const COPD_RULE: ClinicalRule = {
  condition_code: "J44.1",
  condition_display: "COPD exacerbation",
  guideline_source: "GOLD COPD Guidelines 2024",
  guideline_url:
    "https://goldcopd.org/2024-gold-report/",
  last_reviewed: "2024-01-15",
  reviewed_by: "Published Clinical Guideline",
  flag_color: "RED",
  readmission_risk_level: "HIGH",
  question_priority: [
    "shortness_of_breath",
    "rescue_inhaler_use",
    "steroid_taken",
    "sputum_colour",
    "medication_adherence",
  ],
  conditions: [
    {
      variable: "shortness_of_breath",
      operator: "==",
      threshold: true,
      weight: 0.9,
      flag_color: "RED",
      clinical_note:
        "Dyspnea at rest or on minimal exertion indicates acute exacerbation",
      source: "GOLD 2024 Chapter 6 — Management of Exacerbations",
    },
    {
      variable: "rescue_inhaler_use",
      operator: ">=",
      threshold: 3,
      weight: 0.8,
      flag_color: "RED",
      clinical_note:
        "Rescue inhaler use ≥3 times/day indicates uncontrolled exacerbation",
      source: "GOLD 2024 Chapter 4 — Pharmacological Treatment",
    },
    {
      variable: "steroid_taken",
      operator: "==",
      threshold: false,
      weight: 0.75,
      flag_color: "YELLOW",
      clinical_note:
        "Non-adherence to systemic corticosteroids prolongs exacerbation",
      source: "GOLD 2024 Chapter 6 — Systemic Corticosteroids",
    },
    {
      variable: "sputum_colour",
      operator: "==",
      threshold: true,
      weight: 0.7,
      flag_color: "YELLOW",
      clinical_note:
        "Purulent sputum indicates bacterial infection requiring antibiotic therapy",
      source: "GOLD 2024 Chapter 6 — Antibiotic Therapy",
    },
    {
      variable: "medication_adherence",
      operator: "==",
      threshold: false,
      weight: 0.6,
      flag_color: "YELLOW",
      clinical_note:
        "Non-adherence to maintenance inhalers increases readmission risk",
      source: "GOLD 2024 Chapter 5 — Non-Pharmacological Therapy",
    },
  ],
  logic: "OR",
  weighted_threshold: 0.65,
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("══════════════════════════════════════════════════════");
  console.log("STEP 0 — Seed P007 (Eleanor Kim, J44.1 COPD)");
  console.log("══════════════════════════════════════════════════════\n");

  const results: Record<string, "PUT" | "SKIP" | "FAIL" | "EXISTS" | "SEEDED"> = {};

  // ── FHIR Patient ──
  const patientResult = await putFhir("Patient", "P007", P007_PATIENT);
  results["FHIR Patient P007"] = patientResult;
  console.log(`[${patientResult}] Patient/P007`);

  // ── FHIR Condition ──
  const condResult = await putFhir("Condition", "COND-P007-1", P007_CONDITION);
  results["FHIR Condition J44.1"] = condResult;
  console.log(`[${condResult}] Condition/COND-P007-1 (J44.1)`);

  // ── FHIR Medications ──
  for (const med of P007_MEDICATIONS) {
    const r = await putFhir("MedicationRequest", med.id, med);
    results[`FHIR ${med.id}`] = r;
    const display = (med.medicationCodeableConcept.coding[0]?.display ?? med.id).slice(0, 35);
    console.log(`[${r}] MedicationRequest/${med.id} — ${display}`);
  }

  // ── FHIR Encounters ──
  for (const enc of P007_ENCOUNTERS) {
    const r = await putFhir("Encounter", enc.id, enc.body);
    results[`FHIR ${enc.id}`] = r;
    console.log(`[${r}] Encounter/${enc.id}`);
  }

  // ── DynamoDB COPD rule ──
  console.log("");
  const dynamo = makeDynamo();
  const rulesTable = process.env["DYNAMO_TABLE_RULES"] ?? "ClinicalRules";

  const existing = await dynamo.send(
    new GetItemCommand({
      TableName: rulesTable,
      Key: marshall({ condition_code: "J44.1" }),
    })
  );

  if (existing.Item) {
    const row = unmarshall(existing.Item) as { condition_code: string };
    results["DynamoDB J44.1 rule"] = "EXISTS";
    console.log(`[SKIP] ClinicalRules/${row.condition_code} already exists`);
  } else {
    await dynamo.send(
      new PutItemCommand({
        TableName: rulesTable,
        Item: marshall(COPD_RULE, { removeUndefinedValues: true }),
      })
    );
    results["DynamoDB J44.1 rule"] = "SEEDED";
    console.log(`[PUT]  ClinicalRules/J44.1 — GOLD COPD Guidelines 2024`);
  }

  // ── Verification ──
  console.log("\n── Verification ──────────────────────────────────────");

  const patientCheck = await fetch(`${fhirBase()}/Patient/P007`);
  const admitCheck = await fetch(`${fhirBase()}/Encounter/ENC-P007-ADMIT`);
  const ed1Check = await fetch(`${fhirBase()}/Encounter/ENC-P007-ED-1`);
  const ed2Check = await fetch(`${fhirBase()}/Encounter/ENC-P007-ED-2`);
  const ruleCheck = await dynamo.send(
    new GetItemCommand({
      TableName: rulesTable,
      Key: marshall({ condition_code: "J44.1" }),
    })
  );

  console.log(`Patient/P007:          ${patientCheck.ok ? "EXISTS" : "NOT FOUND"}`);
  console.log(`Encounter/ENC-P007-ADMIT: ${admitCheck.ok ? "EXISTS" : "NOT FOUND"}`);
  console.log(`Encounter/ENC-P007-ED-1:  ${ed1Check.ok ? "EXISTS" : "NOT FOUND"}`);
  console.log(`Encounter/ENC-P007-ED-2:  ${ed2Check.ok ? "EXISTS" : "NOT FOUND"}`);
  console.log(`ClinicalRules/J44.1:   ${ruleCheck.Item ? "EXISTS" : "NOT FOUND"}`);

  const allOk =
    patientCheck.ok &&
    admitCheck.ok &&
    ed1Check.ok &&
    ed2Check.ok &&
    !!ruleCheck.Item;

  console.log(`\nStep 0: ${allOk ? "PASS" : "FAIL"}`);
  if (!allOk) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("step0-seed failed:", err);
  process.exit(1);
});
