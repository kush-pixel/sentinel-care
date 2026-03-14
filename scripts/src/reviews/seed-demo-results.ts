import * as dotenv from "dotenv";
import * as path from "path";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { type DashboardPayload } from "@sentinel/schemas";
import { getLaceForPatient } from "@sentinel/lace";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function makeClient(): DynamoDBClient {
  return new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  });
}

function makeDocClient(raw: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(raw);
}

function table(): string {
  return process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults";
}

function patientsTable(): string {
  return process.env["DYNAMO_TABLE_PATIENTS"] ?? "PatientProfiles";
}

// ─── Extended record type ──────────────────────────────────────────────────────

type ExtractedVariable = { value: number | boolean | string; confidence: number };

type CallResultRecord = DashboardPayload & {
  call_timestamp: string;
  variables: Record<string, ExtractedVariable>;
  unresolved_variables: string[];
  lace_score?: number;
  lace_risk_level?: string;
  lace_components?: { L: number; A: number; C: number; E: number };
};

// ─── Static demo records (LACE filled in at runtime from PatientProfiles) ────

const BASE_RECORDS: Omit<CallResultRecord, "lace_score" | "lace_risk_level" | "lace_components">[] = [
  {
    call_id: "C001",
    patient_id: "P001",
    triage_status: "RED",
    broken_rules: ["weight_gain_lbs >= 3", "lasix_filled == false"],
    weighted_score: 0.85,
    sbar_summary:
      "S: Patient reports 4lb weight gain in 2 days and has not filled Lasix prescription. B: 71yo female with CHF discharged on Furosemide 40mg daily per Dr. Sarah Chen. A: Weight gain exceeds AHA 3lb readmission threshold. Medication non-adherence compounds fluid retention risk. R: Immediate nurse callback required. Consider urgent readmission assessment per AHA Heart Failure Guidelines 2022.",
    transcript_warnings: [],
    nurse_acknowledged: false,
    acknowledged_by: null,
    acknowledged_at: null,
    call_status: "COMPLETE",
    escalation_triggered: true,
    protocol_source: "validated_library",
    condition_code: "I50.9",
    call_timestamp: "2026-03-08T14:23:00Z",
    // weight_gain_lbs >= 3 (w=0.9) + lasix_filled == false (w=0.8) → score 1.7 >= threshold 0.75 → RED
    variables: {
      weight_gain_lbs:      { value: 4,     confidence: 0.95 },
      shortness_of_breath:  { value: false,  confidence: 0.90 },
      lasix_filled:         { value: false,  confidence: 0.95 },
      ankle_swelling:       { value: false,  confidence: 0.90 },
      appetite:             { value: true,   confidence: 0.90 },
      mobility:             { value: true,   confidence: 0.90 },
    },
    unresolved_variables: [],
  },
  {
    call_id: "C002",
    patient_id: "P002",
    triage_status: "YELLOW",
    broken_rules: ["pain_level >= 7"],
    weighted_score: 0.7,
    sbar_summary:
      "S: Patient rates pain 7/10 at surgical site. B: 64yo male post-op right knee replacement discharged yesterday per Dr. James Park. A: Pain level meets AAOS threshold for management review. No fever or wound drainage reported. R: Review pain management plan. Consider earlier follow-up appointment per AAOS Post-op Care Guidelines 2023.",
    transcript_warnings: [],
    nurse_acknowledged: false,
    acknowledged_by: null,
    acknowledged_at: null,
    call_status: "COMPLETE",
    escalation_triggered: false,
    protocol_source: "validated_library",
    condition_code: "Z96.651",
    call_timestamp: "2026-03-08T14:45:00Z",
    // pain_level >= 7 (w=0.7) → score 0.7 >= threshold 0.7 → YELLOW
    variables: {
      pain_level:           { value: 8,     confidence: 0.95 },
      fever:                { value: 98.6,  confidence: 0.90 },
      wound_drainage:       { value: false,  confidence: 0.90 },
      mobility:             { value: true,   confidence: 0.90 },
      medication_adherence: { value: true,   confidence: 0.90 },
    },
    unresolved_variables: [],
  },
  {
    call_id: "C003",
    patient_id: "P003",
    triage_status: "GREEN",
    broken_rules: [],
    weighted_score: 0.2,
    sbar_summary:
      "S: Patient reports feeling well, taking medications as prescribed. B: 58yo female with Type 2 diabetes discharged yesterday per Dr. Priya Patel. A: No clinical thresholds exceeded per ADA Standards of Care 2024. Blood sugar within acceptable range. R: Continue current management. Schedule routine follow-up appointment in 2 weeks.",
    transcript_warnings: [],
    nurse_acknowledged: false,
    acknowledged_by: null,
    acknowledged_at: null,
    call_status: "COMPLETE",
    escalation_triggered: false,
    protocol_source: "validated_library",
    condition_code: "E11.9",
    call_timestamp: "2026-03-08T15:00:00Z",
    // no conditions trigger → score 0 < threshold 0.7 → GREEN
    variables: {
      blood_sugar_level:    { value: 150,   confidence: 0.90 },
      medication_adherence: { value: true,   confidence: 0.90 },
      dizziness:            { value: false,  confidence: 0.90 },
      fever:                { value: 98.6,  confidence: 0.90 },
      appetite:             { value: true,   confidence: 0.90 },
      mobility:             { value: true,   confidence: 0.90 },
    },
    unresolved_variables: [],
  },
  // P004 is intentionally excluded —
  // protocol is PENDING_REVIEW.
  // No call result should exist until
  // the protocol is approved by a clinician.
  {
    call_id: "C005",
    patient_id: "P005",
    triage_status: "RED",
    broken_rules: ["chest_pain == true", "medication_adherence == false"],
    weighted_score: 0.92,
    sbar_summary:
      "S: Patient reports intermittent chest pain and has not taken prescribed medications. B: 66yo Spanish-speaking female post-acute MI discharged 2 days ago per Dr. Michael Torres. A: Chest pain and dual antiplatelet non-adherence indicate high stent thrombosis risk per AHA/ACC STEMI Guidelines 2023. R: Emergency nurse callback required. Consider immediate cardiology consultation.",
    transcript_warnings: [],
    nurse_acknowledged: false,
    acknowledged_by: null,
    acknowledged_at: null,
    call_status: "COMPLETE",
    escalation_triggered: true,
    protocol_source: "validated_library",
    condition_code: "I21.9",
    call_timestamp: "2026-03-08T15:30:00Z",
    // chest_pain == true (w=0.95) + medication_adherence == false (w=0.85) → score 1.8 >= threshold 0.8 → RED
    variables: {
      chest_pain:           { value: true,   confidence: 0.95 },
      shortness_of_breath:  { value: false,  confidence: 0.90 },
      medication_adherence: { value: false,  confidence: 0.95 },
      dizziness:            { value: false,  confidence: 0.90 },
      fever:                { value: 98.6,  confidence: 0.90 },
      mobility:             { value: true,   confidence: 0.90 },
    },
    unresolved_variables: [],
  },
  {
    call_id: "C006",
    patient_id: "P006",
    triage_status: "INCOMPLETE",
    broken_rules: [],
    sbar_summary:
      "S: Automated call was not completed. Patient did not answer. B: 73yo male with CKD Stage 3 discharged yesterday per Dr. Lisa Wong. A: Unable to assess clinical status. Manual follow-up required within 2 hours per protocol. R: Nurse to attempt direct contact. If unreachable within 2 hours escalate to attending physician.",
    transcript_warnings: [
      {
        section: "call_initiation",
        warning:
          "Patient did not answer after 3 attempts. Call marked incomplete.",
      },
    ],
    nurse_acknowledged: false,
    acknowledged_by: null,
    acknowledged_at: null,
    call_status: "INCOMPLETE",
    escalation_triggered: false,
    protocol_source: "none",
    condition_code: "N18.3",
    call_timestamp: "2026-03-08T15:45:00Z",
    // call_status INCOMPLETE + empty variables → hard-stop INCOMPLETE
    variables: {},
    unresolved_variables: [
      "swelling",
      "medication_adherence",
      "shortness_of_breath",
      "appetite",
      "dizziness",
      "mobility",
    ],
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const raw = makeClient();
  const docClient = makeDocClient(raw);

  console.log("Seeding demo call results (idempotent)...\n");
  console.log("Reading LACE from PatientProfiles...");

  const records: CallResultRecord[] = [];

  for (const base of BASE_RECORDS) {
    const patientId = base.patient_id;
    const stored = await getLaceForPatient(patientId, docClient, patientsTable());

    if (stored) {
      console.log(
        `  ${patientId}: LACE ${stored.totalScore} ${stored.riskLevel} (from PatientProfiles)`
      );
    } else {
      console.warn(
        `  ⚠ ${patientId}: No LACE in PatientProfiles — using defaults. Run lace:hydrate first.`
      );
    }

    records.push({
      ...base,
      lace_score:      stored?.totalScore ?? 0,
      lace_risk_level: stored?.riskLevel  ?? "UNKNOWN",
      ...(stored ? { lace_components: stored.components } : {}),
    });
  }

  console.log();

  for (const record of records) {
    await raw.send(
      new PutItemCommand({
        TableName: table(),
        Item: marshall(record, { removeUndefinedValues: true }),
      })
    );
    console.log(
      `[PUT] ${record.call_id} | ${record.patient_id} | ${record.triage_status} | LACE ${record.lace_score ?? 0} ${record.lace_risk_level ?? "UNKNOWN"}`
    );
  }

  console.log("\nAll 5 demo call results written (P004 excluded — protocol pending review).");
}

main().catch((err: unknown) => {
  console.error("seed-demo-results failed:", err);
  process.exit(1);
});
