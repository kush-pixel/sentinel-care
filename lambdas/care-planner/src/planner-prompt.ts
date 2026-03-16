// Pure string construction — zero AWS imports, zero AI calls.

import { type ClinicalRule, type LaceResult } from "@sentinel/schemas";
import { type FhirFullRecord } from "../../../scripts/src/fhir/fhir-client";

export interface PlannerPromptInput {
  patient: FhirFullRecord;
  rules: ClinicalRule[];
  targetLanguage: string;
  laceResult: LaceResult;
  regenerationContext?: string;
}

function calculateAge(birthDate: string): number {
  const birth = new Date(birthDate);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

export function buildCarePlannerPrompt(input: PlannerPromptInput): string {
  const { patient: record, rules, targetLanguage, laceResult, regenerationContext } = input;
  const p = record.patient;

  const patientId = p.id;
  const age = p.birthDate ? calculateAge(p.birthDate) : "Unknown";
  const gender = p.gender ?? "Unknown";
  const dischargeDate =
    p.extension?.find((e) => e.url === "discharge-date")?.valueDate ?? "Unknown";
  const attendingPhysician =
    p.extension?.find((e) => e.url === "attending-physician")?.valueString ?? "Unknown";

  const conditionsList = record.conditions
    .map((c) => {
      const coding = c.code.coding[0];
      return `  - ${coding?.code ?? "?"}: ${coding?.display ?? "Unknown condition"}`;
    })
    .join("\n");

  const medicationsList = record.medications
    .map((m) => {
      const coding = m.medicationCodeableConcept.coding[0];
      return `  - ${coding?.code ?? "?"}: ${coding?.display ?? "Unknown medication"}`;
    })
    .join("\n");

  const rulesJson = rules
    .map((r) => JSON.stringify(r, null, 2))
    .join("\n\n");

  // ─── Section A — Role and hard constraints ─────────────────────────────────

  const sectionA = `You are a clinical care planner AI for a post-discharge triage system. Generate a personalised triage protocol for the patient below.

HARD RULES — NEVER VIOLATE THESE:
1. Use ONLY threshold values from the VALIDATED CLINICAL RULES section below. Never invent thresholds.
2. Any threshold not present in the rules is FORBIDDEN.
3. You may ONLY personalise:
   - question_priority order (most urgent first)
   - condition weights (adjust for this patient's risk)
   - preferred_language
   - flag_color (based on highest risk in rules)
4. Output ONLY valid JSON. No preamble. No explanation. No markdown. No backticks. Raw JSON only.
5. question_priority MUST contain a MINIMUM of 5 variables. Never generate fewer than 5 questions.
6. weighted_threshold MUST be between 0.60 and 0.70 (inclusive). NEVER set it higher than 0.70.
7. Weight assignment guidelines (condition-specific risk only):
   - Critical symptoms (acute deterioration, hospitalization risk): 0.85 - 0.95
   - Significant symptoms (treatment adherence, major indicators): 0.70 - 0.85
   - Monitoring symptoms (routine follow-up, secondary indicators): 0.55 - 0.70
8. Every question MUST be specific to the patient's primary condition (ICD-10 code). Do NOT include questions for unrelated conditions.
9. EVERY condition in the conditions array MUST include a flag_color field:
   - flag_color: "RED" for weight >= 0.80 (urgent, potentially life-threatening)
   - flag_color: "YELLOW" for weight < 0.80 (significant but non-urgent monitoring)
   Never omit flag_color from any condition. Never use null or empty string.`;

  // ─── Section B — Language ──────────────────────────────────────────────────

  const sectionB =
    targetLanguage === "es"
      ? "Set preferred_language to 'es'. Patient speaks Spanish."
      : "Set preferred_language to 'en'.";

  // ─── Section C — Patient clinical summary ──────────────────────────────────

  const sectionC = `PATIENT CLINICAL SUMMARY:
Patient ID: ${patientId}
Age: ${age}
Gender: ${gender}
Discharge Date: ${dischargeDate}
Attending Physician: ${attendingPhysician}

LACE READMISSION RISK SCORE: ${laceResult.totalScore} (${laceResult.riskLevel})
${laceResult.interpretation}
Components: L=${laceResult.components.L} A=${laceResult.components.A} C=${laceResult.components.C} E=${laceResult.components.E}

Active Conditions:
${conditionsList}

Current Medications:
${medicationsList}`;

  // ─── Section D — Validated clinical rules ──────────────────────────────────

  const sectionD = rules.length > 0
    ? `VALIDATED CLINICAL RULES — USE THESE EXACT THRESHOLDS:

${rulesJson}

DO NOT use any threshold not listed above.`
    : `VALIDATED CLINICAL RULES: None found for this patient's conditions.
You must generate safe, general post-discharge thresholds.
Use only boolean (true/false) thresholds and numeric values in standard clinical ranges.`;

  // ─── Section Regen — Regeneration context (injected when nurse rejected) ───

  const sectionRegen = regenerationContext
    ? `IMPORTANT — PROTOCOL REGENERATION:
A clinician reviewed the previous version of this protocol and rejected it with the following feedback:

'${regenerationContext}'

You MUST address this feedback in your revised protocol. However, the following rules are NON-NEGOTIABLE:
1. All thresholds from the validated clinical rules must be respected exactly as specified
2. You may ADD questions to address the feedback but may NOT remove any questions that are already in the validated rule set
3. You may adjust question priority/ordering to better reflect the clinical concern raised
4. The flag_color assignments from validated rules cannot be changed

Generate a corrected protocol that incorporates this feedback while respecting all clinical rules.`
    : null;

  // ─── Section E — Required output schema ────────────────────────────────────

  const sectionE = `Generate a JSON object matching exactly this structure:
{
  "patient_id": "<string>",
  "preferred_language": "<string>",
  "flag_color": "<GREEN | YELLOW | RED>",
  "question_priority": ["<variable1>", "<variable2>", "<variable3>", "<variable4>", "<variable5>"],
  "root_node": {
    "logic": "<AND | OR>",
    "conditions": [
      {
        "variable": "<string>",
        "operator": "<>= | <= | == | > | <>",
        "threshold": "<number or boolean>",
        "weight": "<number 0.0–1.0>",
        "flag_color": "<RED | YELLOW>"
      }
    ],
    "weighted_threshold": "<number 0.60–0.70>"
  }
}

CONSTRAINT: question_priority must list AT LEAST 5 variables. weighted_threshold must be >= 0.60 and <= 0.70.`;

  // ─── Section F — Example output ────────────────────────────────────────────

  const sectionF = `EXAMPLE OUTPUT (CHF patient I50.9 — shows correct structure with 5+ questions, weights, and threshold 0.60-0.70):
{
  "patient_id": "P001",
  "preferred_language": "en",
  "flag_color": "RED",
  "question_priority": ["weight_gain_lbs", "shortness_of_breath", "lasix_filled", "ankle_swelling", "chest_pain"],
  "root_node": {
    "logic": "OR",
    "conditions": [
      { "variable": "weight_gain_lbs",     "operator": ">=", "threshold": 3,    "weight": 0.92, "flag_color": "RED"    },
      { "variable": "shortness_of_breath", "operator": "==", "threshold": true, "weight": 0.88, "flag_color": "RED"    },
      { "variable": "lasix_filled",        "operator": "==", "threshold": false,"weight": 0.80, "flag_color": "RED"    },
      { "variable": "ankle_swelling",      "operator": "==", "threshold": true, "weight": 0.72, "flag_color": "YELLOW" },
      { "variable": "chest_pain",          "operator": "==", "threshold": true, "weight": 0.65, "flag_color": "YELLOW" }
    ],
    "weighted_threshold": 0.65
  }
}

Notice: weighted_threshold = 0.65 (within 0.60-0.70). Five condition-specific CHF questions. Critical symptoms (weight gain, SOB) weighted 0.85-0.95. Monitoring symptoms weighted 0.55-0.70.`;

  // ─── Section G — LACE personalisation ─────────────────────────────────────

  let laceInstruction: string;
  if (laceResult.riskLevel === "HIGH" || laceResult.riskLevel === "VERY HIGH") {
    laceInstruction = `Based on the LACE score of ${laceResult.totalScore} (${laceResult.riskLevel}):
Prioritise the most critical condition-specific safety questions first.
Set flag_color to RED.
Weight acute symptom variables 0.85-0.95.
Generate at least 5-6 questions covering: acute symptoms, medication adherence, vital signs, functional status, and warning signs specific to this condition.`;
  } else if (laceResult.riskLevel === "MODERATE") {
    laceInstruction = `Based on the LACE score of ${laceResult.totalScore} (${laceResult.riskLevel}):
Balance urgency with routine follow-up questions specific to this condition.
Set flag_color to YELLOW.
Generate at least 5 questions covering: key symptom monitoring, medication adherence, vital signs, and condition-specific warning signs.`;
  } else {
    laceInstruction = `Based on the LACE score of ${laceResult.totalScore} (${laceResult.riskLevel}):
Standard follow-up protocol appropriate — still generate at least 5 condition-specific questions.
Set flag_color to GREEN unless a rule triggers RED.
Cover: symptom check, medication adherence, vital signs, activity tolerance, and follow-up compliance.`;
  }
  const sectionG = `${laceInstruction}
REMINDER: weighted_threshold must be 0.60-0.70. All questions must be specific to the patient's condition.
Remember: use only the threshold values provided above.`;

  // ─── Section H — Final instruction ────────────────────────────────────────

  const sectionH = `Now generate the triage protocol for patient ${patientId}. Output ONLY the JSON object. Nothing else.`;

  // ─── Assemble prompt ───────────────────────────────────────────────────────

  return [sectionA, sectionB, sectionC, sectionD, ...(sectionRegen ? [sectionRegen] : []), sectionE, sectionF, sectionG, sectionH]
    .join("\n\n");
}
