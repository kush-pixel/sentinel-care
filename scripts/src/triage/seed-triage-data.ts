/**
 * seed-triage-data.ts
 *
 * Seeds TriageProtocols and CallResults tables with data that the
 * triage-engine local-test can evaluate.  Designed to produce the exact
 * expected triage outcomes:
 *
 *   P001 → RED   (CHF: weight gain + Lasix non-adherence)
 *   P002 → YELLOW (post-knee: pain 7/10)
 *   P003 → GREEN  (diabetes: all values normal)
 *   P004 → RED   (pneumonia: fever + antibiotic non-adherence)
 *   P005 → RED   (post-MI: chest pain + medication non-adherence)
 *   P006 → INCOMPLETE (CKD: patient did not answer)
 */

import * as dotenv from "dotenv";
import * as path from "path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { TriageProtocol, PatientAnswers } from "@sentinel/schemas";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function makeClient(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  });
  return DynamoDBDocumentClient.from(raw);
}

const PROTOCOLS_TABLE = process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols";
const RESULTS_TABLE   = process.env["DYNAMO_TABLE_RESULTS"]   ?? "CallResults";

// ─── Protocol definitions ─────────────────────────────────────────────────────

const protocols: Array<{
  patient_id: string;
  lace_score: number;
  lace_risk_level: string;
  condition_code: string;
  protocol: TriageProtocol;
}> = [
  {
    patient_id: "P001",
    lace_score: 10,
    lace_risk_level: "HIGH",
    condition_code: "I50.9",
    protocol: {
      patient_id: "P001",
      preferred_language: "en",
      flag_color: "RED",
      question_priority: ["weight_gain_lbs", "shortness_of_breath", "lasix_filled", "ankle_swelling"],
      root_node: {
        logic: "OR",
        conditions: [
          { variable: "weight_gain_lbs",     operator: ">=", threshold: 3,    weight: 0.9  },
          { variable: "shortness_of_breath", operator: "==", threshold: true, weight: 0.85 },
          { variable: "lasix_filled",        operator: "==", threshold: false, weight: 0.8  },
        ],
        weighted_threshold: 0.75,
      },
    },
  },
  {
    patient_id: "P002",
    lace_score: 5,
    lace_risk_level: "LOW",
    condition_code: "Z96.651",
    protocol: {
      patient_id: "P002",
      preferred_language: "en",
      flag_color: "YELLOW",
      question_priority: ["pain_level", "fever", "wound_drainage"],
      root_node: {
        logic: "OR",
        conditions: [
          { variable: "pain_level",     operator: ">=", threshold: 7,    weight: 0.7  },
          { variable: "fever",          operator: ">=", threshold: 101,  weight: 0.9  },
          { variable: "wound_drainage", operator: "==", threshold: true, weight: 0.85 },
        ],
        weighted_threshold: 0.65,
      },
    },
  },
  {
    patient_id: "P003",
    lace_score: 4,
    lace_risk_level: "LOW",
    condition_code: "E11.9",
    protocol: {
      patient_id: "P003",
      preferred_language: "en",
      flag_color: "RED",
      question_priority: ["blood_sugar_level", "medication_adherence", "dizziness"],
      root_node: {
        logic: "OR",
        conditions: [
          { variable: "blood_sugar_level",    operator: ">=", threshold: 300,  weight: 0.9  },
          { variable: "medication_adherence", operator: "==", threshold: false, weight: 0.8  },
          { variable: "dizziness",            operator: "==", threshold: true,  weight: 0.75 },
        ],
        weighted_threshold: 0.7,
      },
    },
  },
  {
    patient_id: "P004",
    lace_score: 7,
    lace_risk_level: "HIGH",
    condition_code: "J18.9",
    protocol: {
      patient_id: "P004",
      preferred_language: "en",
      flag_color: "RED",
      question_priority: ["shortness_of_breath", "fever", "antibiotic_taken", "confusion"],
      root_node: {
        logic: "OR",
        conditions: [
          { variable: "shortness_of_breath", operator: "==", threshold: true,  weight: 0.9  },
          { variable: "fever",               operator: ">=", threshold: 101,   weight: 0.85 },
          { variable: "antibiotic_taken",    operator: "==", threshold: false,  weight: 0.9  },
          { variable: "confusion",           operator: "==", threshold: true,  weight: 0.95 },
        ],
        weighted_threshold: 0.8,
      },
    },
  },
  {
    patient_id: "P005",
    lace_score: 9,
    lace_risk_level: "HIGH",
    condition_code: "I21.9",
    protocol: {
      patient_id: "P005",
      preferred_language: "es",
      flag_color: "RED",
      question_priority: ["chest_pain", "medication_adherence", "shortness_of_breath"],
      root_node: {
        logic: "OR",
        conditions: [
          { variable: "chest_pain",           operator: "==", threshold: true,  weight: 0.9  },
          { variable: "medication_adherence", operator: "==", threshold: false,  weight: 0.85 },
          { variable: "shortness_of_breath",  operator: "==", threshold: true,  weight: 0.8  },
        ],
        weighted_threshold: 0.8,
      },
    },
  },
  {
    patient_id: "P006",
    lace_score: 4,
    lace_risk_level: "LOW",
    condition_code: "N18.3",
    protocol: {
      patient_id: "P006",
      preferred_language: "en",
      flag_color: "YELLOW",
      question_priority: ["appetite", "swelling", "confusion", "mobility"],
      root_node: {
        logic: "OR",
        conditions: [
          { variable: "appetite",   operator: "==", threshold: false, weight: 0.7  },
          { variable: "swelling",   operator: "==", threshold: true,  weight: 0.75 },
          { variable: "confusion",  operator: "==", threshold: true,  weight: 0.8  },
        ],
        weighted_threshold: 0.65,
      },
    },
  },
];

// ─── PatientAnswers records ────────────────────────────────────────────────────
// Each record is a full CallResults item: PatientAnswers fields PLUS base
// dashboard fields that the triage engine will later overwrite via UpdateCommand.

type CallResultSeed = PatientAnswers & {
  condition_code: string;
  sbar_summary: string;
  escalation_triggered: boolean;
  nurse_acknowledged: boolean;
  acknowledged_by: null;
  acknowledged_at: null;
  protocol_source: string;
  call_timestamp: string;
};

const callResults: CallResultSeed[] = [
  {
    call_id: "C001",
    patient_id: "P001",
    call_status: "COMPLETE",
    variables: {
      weight_gain_lbs:     { value: 4,     confidence: 0.95 },
      shortness_of_breath: { value: false,  confidence: 0.90 },
      lasix_filled:        { value: false,  confidence: 0.88 },
      ankle_swelling:      { value: true,   confidence: 0.85 },
    },
    unresolved_variables: [],
    transcript_warnings: [],
    condition_code: "I50.9",
    sbar_summary: "Pending triage evaluation.",
    escalation_triggered: false,
    nurse_acknowledged: false,
    acknowledged_by: null,
    acknowledged_at: null,
    protocol_source: "validated_library",
    call_timestamp: "2026-03-08T14:23:00Z",
  },
  {
    call_id: "C002",
    patient_id: "P002",
    call_status: "COMPLETE",
    variables: {
      pain_level:     { value: 7,     confidence: 0.92 },
      fever:          { value: 98.6,  confidence: 0.90 },
      wound_drainage: { value: false,  confidence: 0.88 },
    },
    unresolved_variables: [],
    transcript_warnings: [],
    condition_code: "Z96.651",
    sbar_summary: "Pending triage evaluation.",
    escalation_triggered: false,
    nurse_acknowledged: false,
    acknowledged_by: null,
    acknowledged_at: null,
    protocol_source: "validated_library",
    call_timestamp: "2026-03-08T14:45:00Z",
  },
  {
    call_id: "C003",
    patient_id: "P003",
    call_status: "COMPLETE",
    variables: {
      blood_sugar_level:    { value: 180,  confidence: 0.90 },
      medication_adherence: { value: true,  confidence: 0.95 },
      dizziness:            { value: false, confidence: 0.90 },
    },
    unresolved_variables: [],
    transcript_warnings: [],
    condition_code: "E11.9",
    sbar_summary: "Pending triage evaluation.",
    escalation_triggered: false,
    nurse_acknowledged: false,
    acknowledged_by: null,
    acknowledged_at: null,
    protocol_source: "validated_library",
    call_timestamp: "2026-03-08T15:00:00Z",
  },
  {
    call_id: "C004",
    patient_id: "P004",
    call_status: "COMPLETE",
    variables: {
      shortness_of_breath: { value: false,   confidence: 0.90 },
      fever:               { value: 101.5,   confidence: 0.88 },
      antibiotic_taken:    { value: false,    confidence: 0.92 },
      confusion:           { value: false,   confidence: 0.90 },
    },
    unresolved_variables: [],
    transcript_warnings: [],
    condition_code: "J18.9",
    sbar_summary: "Pending triage evaluation.",
    escalation_triggered: false,
    nurse_acknowledged: false,
    acknowledged_by: null,
    acknowledged_at: null,
    protocol_source: "validated_library",
    call_timestamp: "2026-03-08T15:15:00Z",
  },
  {
    call_id: "C005",
    patient_id: "P005",
    call_status: "COMPLETE",
    variables: {
      chest_pain:           { value: true,  confidence: 0.95 },
      medication_adherence: { value: false,  confidence: 0.90 },
      shortness_of_breath:  { value: false,  confidence: 0.88 },
    },
    unresolved_variables: [],
    transcript_warnings: [],
    condition_code: "I21.9",
    sbar_summary: "Pending triage evaluation.",
    escalation_triggered: false,
    nurse_acknowledged: false,
    acknowledged_by: null,
    acknowledged_at: null,
    protocol_source: "validated_library",
    call_timestamp: "2026-03-08T15:30:00Z",
  },
  {
    call_id: "C006",
    patient_id: "P006",
    call_status: "INCOMPLETE",
    variables: {},
    unresolved_variables: [],
    transcript_warnings: [
      {
        section: "call_initiation",
        warning: "Patient did not answer after 3 attempts. Call marked incomplete.",
      },
    ],
    condition_code: "N18.3",
    sbar_summary: "Automated call was not completed. Patient did not answer.",
    escalation_triggered: false,
    nurse_acknowledged: false,
    acknowledged_by: null,
    acknowledged_at: null,
    protocol_source: "none",
    call_timestamp: "2026-03-08T15:45:00Z",
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const client = makeClient();
  const now = new Date().toISOString();

  console.log("Seeding TriageProtocols (idempotent)...\n");
  for (const entry of protocols) {
    await client.send(
      new PutCommand({
        TableName: PROTOCOLS_TABLE,
        Item: {
          patient_id:      entry.patient_id,
          protocol:        entry.protocol,
          lace_score:      entry.lace_score,
          lace_risk_level: entry.lace_risk_level,
          condition_code:  entry.condition_code,
          created_at:      now,
          approved_by:     "SEED",
        },
      })
    );
    console.log(`[PROTOCOL] ${entry.patient_id} → ${entry.protocol.flag_color}`);
  }

  console.log("\nSeeding CallResults with PatientAnswers (idempotent)...\n");
  for (const record of callResults) {
    await client.send(
      new PutCommand({
        TableName: RESULTS_TABLE,
        Item: record,
      })
    );
    console.log(`[CALL] ${record.call_id} | ${record.patient_id} | ${record.call_status}`);
  }

  console.log(`\nDone — 6 protocols + 6 call results written.`);
}

main().catch((err: unknown) => {
  console.error("seed-triage-data failed:", err);
  process.exit(1);
});
