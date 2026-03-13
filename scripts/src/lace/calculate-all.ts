import * as dotenv from "dotenv";
import * as path from "path";
import { getFullPatientRecord } from "../fhir/fhir-client";
import { calculateLaceScore } from "@sentinel/lace";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const PATIENT_IDS = ["P001", "P002", "P003", "P004", "P005", "P006", "P007"];

const CONDITION_LABEL: Record<string, string> = {
  "I50.9":   "CHF      ",
  "Z96.651": "Knee     ",
  "E11.9":   "Diabetes ",
  "J18.9":   "Pneumonia",
  "I21.9":   "Acute MI ",
  "N18.3":   "CKD      ",
  "J44.1":   "COPD     ",
};

async function main(): Promise<void> {
  console.log("Calculating LACE scores for all patients...\n");

  const rows: Array<{
    patientId: string;
    label: string;
    L: number;
    A: number;
    C: number;
    E: number;
    total: number;
    risk: string;
    interpretation: string;
  }> = [];

  for (const patientId of PATIENT_IDS) {
    const record = await getFullPatientRecord(patientId);
    const { encounterSummary, conditions } = record;

    const conditionCodes = conditions
      .flatMap((c) => c.code.coding)
      .map((coding) => coding.code);

    const primaryCode = conditionCodes[0] ?? "UNKNOWN";
    const label = CONDITION_LABEL[primaryCode] ?? primaryCode.padEnd(9);

    const lace = calculateLaceScore({
      admissionDate: encounterSummary.admissionDate,
      dischargeDate: encounterSummary.dischargeDate,
      admissionType: encounterSummary.admissionType,
      conditionCodes,
      recentEDVisits: encounterSummary.recentEDVisits,
    });

    rows.push({
      patientId,
      label,
      L: lace.components.L,
      A: lace.components.A,
      C: lace.components.C,
      E: lace.components.E,
      total: lace.totalScore,
      risk: lace.riskLevel,
      interpretation: lace.interpretation,
    });
  }

  console.log("─────────────────────────────────────────────────────────────────");
  console.log("LACE SCORE REPORT — ALL PATIENTS");
  console.log("─────────────────────────────────────────────────────────────────");
  console.log("Patient | Condition  | L | A | C | E | Total | Risk");
  console.log("─────────────────────────────────────────────────────────────────");

  for (const r of rows) {
    const total = String(r.total).padStart(2);
    console.log(
      `${r.patientId}     | ${r.label} | ${r.L} | ${r.A} | ${r.C} | ${r.E} |  ${total}   | ${r.risk}`
    );
  }

  console.log("─────────────────────────────────────────────────────────────────");
  console.log("\nInterpretations:");

  for (const r of rows) {
    console.log(`${r.patientId}: ${r.interpretation}`);
  }
}

main().catch((err: unknown) => {
  console.error("calculate-all failed:", err);
  process.exit(1);
});
