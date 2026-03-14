import * as dotenv from "dotenv";
import * as path from "path";
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function makeClient(): DynamoDBClient {
  return new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  });
}

function table(): string {
  return process.env["DYNAMO_TABLE_RULES"] ?? "ClinicalRules";
}

// ─── Clinical rules ───────────────────────────────────────────────────────────

const rules = [
  {
    condition_code: "I50.9",
    condition_display: "Heart failure, unspecified",
    guideline_source: "AHA/ACC 2022 Heart Failure Guidelines",
    guideline_url:
      "https://www.ahajournals.org/doi/10.1161/CIR.0000000000001063",
    last_reviewed: "2024-01-15",
    reviewed_by: "Published Clinical Guideline",
    flag_color: "RED",
    readmission_risk_level: "HIGH",
    question_priority: [
      "weight_gain_lbs",
      "shortness_of_breath",
      "lasix_filled",
      "ankle_swelling",
      "appetite",
      "mobility",
    ],
    conditions: [
      {
        variable: "weight_gain_lbs",
        operator: ">=",
        threshold: 3,
        weight: 0.9,
        flag_color: "RED",
        clinical_note: "3lb gain in 2 days indicates fluid retention",
        source: "AHA Heart Failure Guidelines 2022 Section 7.3",
      },
      {
        variable: "shortness_of_breath",
        operator: "==",
        threshold: true,
        weight: 0.85,
        flag_color: "RED",
        clinical_note: "Dyspnea at rest indicates decompensation",
        source: "ACC/AHA Heart Failure Guideline 2022",
      },
      {
        variable: "lasix_filled",
        operator: "==",
        threshold: false,
        weight: 0.8,
        flag_color: "RED",
        clinical_note: "Diuretic non-adherence is primary readmission cause",
        source: "AHA Heart Failure Guidelines 2022 Section 9.1",
      },
      {
        variable: "ankle_swelling",
        operator: "==",
        threshold: true,
        weight: 0.75,
        flag_color: "YELLOW",
        clinical_note: "Peripheral edema indicates fluid overload",
        source: "AHA Heart Failure Guidelines 2022",
      },
      {
        variable: "appetite",
        operator: "==",
        threshold: false,
        weight: 0.6,
        flag_color: "YELLOW",
        clinical_note: "Poor appetite common in decompensating HF",
        source: "AHA Heart Failure Guidelines 2022",
      },
      {
        variable: "mobility",
        operator: "==",
        threshold: false,
        weight: 0.55,
        flag_color: "YELLOW",
        clinical_note: "Reduced activity tolerance indicates worsening",
        source: "AHA Heart Failure Guidelines 2022",
      },
    ],
    logic: "OR",
    weighted_threshold: 0.75,
  },
  {
    condition_code: "Z96.651",
    condition_display: "Post-op right knee replacement",
    guideline_source: "AAOS Clinical Practice Guidelines 2023",
    guideline_url:
      "https://www.aaos.org/quality/quality-programs/joint-replacement-programs/",
    last_reviewed: "2024-02-01",
    reviewed_by: "Published Clinical Guideline",
    flag_color: "YELLOW",
    readmission_risk_level: "MODERATE",
    question_priority: [
      "pain_level",
      "fever",
      "wound_drainage",
      "mobility",
      "medication_adherence",
    ],
    conditions: [
      {
        variable: "pain_level",
        operator: ">=",
        threshold: 7,
        weight: 0.7,
        flag_color: "YELLOW",
        clinical_note: "Pain above 7 indicates inadequate post-op management",
        source: "AAOS Post-op Care Guidelines 2023",
      },
      {
        variable: "fever",
        operator: ">=",
        threshold: 101,
        weight: 0.9,
        flag_color: "RED",
        clinical_note:
          "Fever post-arthroplasty indicates possible infection",
        source: "AAOS Infection Prevention Guidelines 2023",
      },
      {
        variable: "wound_drainage",
        operator: "==",
        threshold: true,
        weight: 0.85,
        flag_color: "RED",
        clinical_note:
          "Wound drainage increases periprosthetic infection risk",
        source: "AAOS Clinical Practice Guidelines 2023",
      },
      {
        variable: "mobility",
        operator: "==",
        threshold: false,
        weight: 0.65,
        flag_color: "YELLOW",
        clinical_note: "Immobility increases DVT risk post-arthroplasty",
        source: "AAOS VTE Prevention Guidelines 2023",
      },
      {
        variable: "medication_adherence",
        operator: "==",
        threshold: false,
        weight: 0.75,
        flag_color: "YELLOW",
        clinical_note:
          "Non-adherence to anticoagulants increases DVT risk",
        source: "AAOS Clinical Practice Guidelines 2023",
      },
    ],
    logic: "OR",
    weighted_threshold: 0.7,
  },
  {
    condition_code: "E11.9",
    condition_display: "Type 2 diabetes, uncomplicated",
    guideline_source: "ADA Standards of Medical Care in Diabetes 2024",
    guideline_url:
      "https://diabetesjournals.org/care/issue/47/Supplement_1",
    last_reviewed: "2024-01-01",
    reviewed_by: "Published Clinical Guideline",
    flag_color: "YELLOW",
    readmission_risk_level: "LOW",
    question_priority: [
      "blood_sugar_level",
      "medication_adherence",
      "dizziness",
      "appetite",
      "fever",
      "mobility",
    ],
    conditions: [
      {
        variable: "blood_sugar_level",
        operator: ">=",
        threshold: 300,
        weight: 0.9,
        flag_color: "RED",
        clinical_note: "BG above 300 indicates hyperglycemic crisis risk",
        source: "ADA Standards of Care 2024 Section 16",
      },
      {
        variable: "medication_adherence",
        operator: "==",
        threshold: false,
        weight: 0.8,
        flag_color: "YELLOW",
        clinical_note:
          "Metformin non-adherence leads to rapid glucose elevation",
        source: "ADA Standards of Care 2024 Section 9",
      },
      {
        variable: "dizziness",
        operator: "==",
        threshold: true,
        weight: 0.75,
        flag_color: "YELLOW",
        clinical_note:
          "Dizziness may indicate hypoglycemia or dehydration",
        source: "ADA Standards of Care 2024 Section 6",
      },
      {
        variable: "appetite",
        operator: "==",
        threshold: false,
        weight: 0.65,
        flag_color: "YELLOW",
        clinical_note:
          "Poor appetite risks hypoglycemia with ongoing medication",
        source: "ADA Standards of Care 2024",
      },
      {
        variable: "fever",
        operator: ">=",
        threshold: 101,
        weight: 0.7,
        flag_color: "YELLOW",
        clinical_note: "Infection causes significant glucose dysregulation",
        source: "ADA Standards of Care 2024 Section 16",
      },
      {
        variable: "mobility",
        operator: "==",
        threshold: false,
        weight: 0.5,
        flag_color: "YELLOW",
        clinical_note: "Reduced activity affects glucose management",
        source: "ADA Standards of Care 2024 Section 5",
      },
    ],
    logic: "OR",
    weighted_threshold: 0.7,
  },
  {
    condition_code: "J18.9",
    condition_display: "Pneumonia, unspecified organism",
    guideline_source: "IDSA/ATS Community-Acquired Pneumonia Guidelines",
    guideline_url:
      "https://www.idsociety.org/practice-guideline/community-acquired-pneumonia-cap-in-adults/",
    last_reviewed: "2024-01-15",
    reviewed_by: "Published Clinical Guideline",
    flag_color: "RED",
    readmission_risk_level: "HIGH",
    question_priority: [
      "shortness_of_breath",
      "fever",
      "antibiotic_taken",
      "appetite",
      "confusion",
      "mobility",
    ],
    conditions: [
      {
        variable: "shortness_of_breath",
        operator: "==",
        threshold: true,
        weight: 0.9,
        flag_color: "RED",
        clinical_note: "Persistent dyspnea indicates treatment failure",
        source: "IDSA/ATS CAP Guidelines Table 5",
      },
      {
        variable: "fever",
        operator: ">=",
        threshold: 101,
        weight: 0.85,
        flag_color: "RED",
        clinical_note:
          "Persistent fever suggests inadequate antibiotic response",
        source: "IDSA/ATS CAP Guidelines",
      },
      {
        variable: "antibiotic_taken",
        operator: "==",
        threshold: false,
        weight: 0.9,
        flag_color: "RED",
        clinical_note:
          "Antibiotic non-adherence is primary treatment failure cause",
        source: "IDSA/ATS CAP Guidelines Section 8",
      },
      {
        variable: "appetite",
        operator: "==",
        threshold: false,
        weight: 0.65,
        flag_color: "YELLOW",
        clinical_note: "Poor nutritional intake impairs immune response",
        source: "IDSA/ATS CAP Guidelines",
      },
      {
        variable: "confusion",
        operator: "==",
        threshold: true,
        weight: 0.95,
        flag_color: "RED",
        clinical_note: "New confusion is a CURB-65 severity indicator",
        source: "IDSA/ATS CAP Guidelines CURB-65 Score",
      },
      {
        variable: "mobility",
        operator: "==",
        threshold: false,
        weight: 0.6,
        flag_color: "YELLOW",
        clinical_note: "Immobility increases aspiration and DVT risk",
        source: "IDSA/ATS CAP Guidelines",
      },
    ],
    logic: "OR",
    weighted_threshold: 0.8,
  },
  {
    condition_code: "I21.9",
    condition_display: "Acute myocardial infarction, unspecified",
    guideline_source: "AHA/ACC STEMI Guidelines 2023",
    guideline_url:
      "https://www.ahajournals.org/doi/10.1161/CIR.0000000000001123",
    last_reviewed: "2024-01-20",
    reviewed_by: "Published Clinical Guideline",
    flag_color: "RED",
    readmission_risk_level: "HIGH",
    question_priority: [
      "chest_pain",
      "shortness_of_breath",
      "medication_adherence",
      "dizziness",
      "fever",
      "mobility",
    ],
    conditions: [
      {
        variable: "chest_pain",
        operator: "==",
        threshold: true,
        weight: 0.95,
        flag_color: "RED",
        clinical_note: "Any chest pain post-MI requires immediate evaluation",
        source: "AHA/ACC STEMI Guidelines 2023 Section 8",
      },
      {
        variable: "shortness_of_breath",
        operator: "==",
        threshold: true,
        weight: 0.9,
        flag_color: "RED",
        clinical_note: "Dyspnea indicates possible post-MI heart failure",
        source: "AHA/ACC STEMI Guidelines 2023",
      },
      {
        variable: "medication_adherence",
        operator: "==",
        threshold: false,
        weight: 0.85,
        flag_color: "RED",
        clinical_note:
          "Dual antiplatelet non-adherence increases stent thrombosis risk",
        source: "AHA/ACC STEMI Guidelines 2023 Section 9.2",
      },
      {
        variable: "dizziness",
        operator: "==",
        threshold: true,
        weight: 0.75,
        flag_color: "YELLOW",
        clinical_note:
          "Dizziness may indicate hypotension or arrhythmia",
        source: "AHA/ACC STEMI Guidelines 2023",
      },
      {
        variable: "fever",
        operator: ">=",
        threshold: 101,
        weight: 0.7,
        flag_color: "YELLOW",
        clinical_note: "Post-MI fever may indicate Dressler syndrome",
        source: "AHA/ACC STEMI Guidelines 2023",
      },
      {
        variable: "mobility",
        operator: "==",
        threshold: false,
        weight: 0.6,
        flag_color: "YELLOW",
        clinical_note:
          "Activity tolerance is a key post-MI recovery indicator",
        source: "AHA/ACC Cardiac Rehabilitation Guidelines 2023",
      },
    ],
    logic: "OR",
    weighted_threshold: 0.8,
  },
  {
    condition_code: "N18.3",
    condition_display: "Chronic kidney disease, stage 3",
    guideline_source: "KDIGO CKD Guidelines 2024",
    guideline_url:
      "https://kdigo.org/guidelines/ckd-evaluation-and-management/",
    last_reviewed: "2024-03-01",
    reviewed_by: "Published Clinical Guideline",
    flag_color: "YELLOW",
    readmission_risk_level: "MODERATE",
    question_priority: [
      "swelling",
      "medication_adherence",
      "shortness_of_breath",
      "appetite",
      "dizziness",
      "mobility",
    ],
    conditions: [
      {
        variable: "swelling",
        operator: "==",
        threshold: true,
        weight: 0.85,
        flag_color: "RED",
        clinical_note:
          "Edema indicates fluid overload from reduced kidney function",
        source: "KDIGO CKD Guidelines 2024 Chapter 3",
      },
      {
        variable: "medication_adherence",
        operator: "==",
        threshold: false,
        weight: 0.8,
        flag_color: "YELLOW",
        clinical_note:
          "ACE inhibitor non-adherence accelerates CKD progression",
        source: "KDIGO CKD Guidelines 2024 Chapter 4",
      },
      {
        variable: "shortness_of_breath",
        operator: "==",
        threshold: true,
        weight: 0.85,
        flag_color: "RED",
        clinical_note: "Dyspnea in CKD3 indicates fluid overload or anemia",
        source: "KDIGO CKD Guidelines 2024",
      },
      {
        variable: "appetite",
        operator: "==",
        threshold: false,
        weight: 0.7,
        flag_color: "YELLOW",
        clinical_note: "Uremic anorexia indicates worsening kidney function",
        source: "KDIGO CKD Guidelines 2024 Chapter 3",
      },
      {
        variable: "dizziness",
        operator: "==",
        threshold: true,
        weight: 0.65,
        flag_color: "YELLOW",
        clinical_note:
          "Dizziness may indicate anemia or electrolyte imbalance",
        source: "KDIGO CKD Guidelines 2024",
      },
      {
        variable: "mobility",
        operator: "==",
        threshold: false,
        weight: 0.55,
        flag_color: "YELLOW",
        clinical_note:
          "Reduced mobility common in CKD due to fatigue and anemia",
        source: "KDIGO CKD Guidelines 2024",
      },
    ],
    logic: "OR",
    weighted_threshold: 0.7,
  },
];

// ─── Change notes by condition code (for initial v1 seeding) ──────────────────

const CHANGE_NOTES: Record<string, string> = {
  "I50.9":   "Initial rule — AHA/ACC 2022 Heart Failure Guidelines",
  "Z96.651": "Initial rule — AAOS 2023 Post-op Care Guidelines",
  "E11.9":   "Initial rule — ADA Standards of Care 2024",
  "J18.9":   "Initial rule — IDSA/ATS Community-acquired Pneumonia Guidelines",
  "I21.9":   "Initial rule — AHA/ACC STEMI Guidelines 2023",
  "N18.3":   "Initial rule — KDIGO CKD Guidelines 2024",
};

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function seedRules(): Promise<void> {
  const client = makeClient();

  console.log("Seeding clinical rules...\n");

  for (const rule of rules) {
    const code      = rule.condition_code;
    const versionId = `${code}#v1`;

    // Idempotency check — skip if LATEST already points to v1
    const latestRecord = await client.send(
      new GetItemCommand({
        TableName: table(),
        Key: marshall({ condition_code: code, version_id: "LATEST" }),
      })
    );

    if (latestRecord.Item) {
      const existing = unmarshall(latestRecord.Item) as { latest_version_id?: string };
      if (existing.latest_version_id === versionId) {
        console.log(`[SKIP] ${code} already at ${versionId}`);
        continue;
      }
    }

    // RECORD 1 — Versioned rule record
    const now = new Date().toISOString();
    const versionedRule = {
      ...rule,
      version:       1,
      version_id:    versionId,
      is_latest:     true,
      effective_from: "2024-01-01T00:00:00.000Z",
      superseded_by:  null,
      change_notes:   CHANGE_NOTES[code] ?? "Initial rule",
      created_by:     "SYSTEM",
      created_at:     now,
    };

    await client.send(
      new PutItemCommand({
        TableName: table(),
        Item: marshall(versionedRule, { removeUndefinedValues: true }),
      })
    );

    // RECORD 2 — LATEST pointer
    await client.send(
      new PutItemCommand({
        TableName: table(),
        Item: marshall({
          condition_code:    code,
          version_id:        "LATEST",
          latest_version:    1,
          latest_version_id: versionId,
          updated_at:        now,
        }),
      })
    );

    console.log(`[PUT]  ${code} → ${versionId} + LATEST`);
  }

  console.log(
    "\n── Confirmation ─────────────────────────────────────────────────────────────────"
  );
  console.log(
    "condition_code | condition                             | conditions | source          | status"
  );
  console.log(
    "───────────────────────────────────────────────────────────────────────────────────"
  );

  for (const rule of rules) {
    // Verify by reading versioned record (composite key)
    const res = await client.send(
      new GetItemCommand({
        TableName: table(),
        Key: marshall({ condition_code: rule.condition_code, version_id: `${rule.condition_code}#v1` }),
      })
    );
    const status = res.Item ? "OK" : "MISSING";
    const row = res.Item
      ? (unmarshall(res.Item) as Record<string, unknown>)
      : rule;
    const condCode    = String(row["condition_code"]    ?? row.condition_code    ?? "");
    const condDisplay = String(row["condition_display"] ?? row.condition_display ?? "");
    const conditions  = (row["conditions"]              ?? row.conditions)       as { length: number };
    const guidelineSrc = String(row["guideline_source"] ?? row.guideline_source ?? "");
    console.log(
      `${condCode.padEnd(14)} | ${condDisplay.slice(0, 37).padEnd(37)} | ${String(conditions.length).padEnd(10)} | ${guidelineSrc.slice(0, 15).padEnd(15)} | ${status}`
    );
  }
}

async function main(): Promise<void> { await seedRules(); }

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("seed-clinical-rules failed:", err);
    process.exit(1);
  });
}
