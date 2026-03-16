import { type DashboardPayload } from "@sentinel/schemas";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SbarPromptInput {
  patientId: string;
  conditionCode: string;
  conditionDisplay: string;
  triageStatus: DashboardPayload["triage_status"];
  brokenRules: string[];
  brokenRulesNatural: string[];
  weightedScore: number;
  laceScore: number;
  laceRiskLevel: string;
  laceInterpretation: string;
  guidelineSource: string;
  guidelineUrl: string;
  clinicalNotes: string[];
  callTimestamp: string;
  medications: string[];
  dischargeDate: string;
  attendingPhysician: string;
  callStatus: string;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

export function buildSbarPrompt(input: SbarPromptInput): string {
  const {
    patientId,
    conditionCode,
    conditionDisplay,
    triageStatus,
    brokenRules,
    brokenRulesNatural,
    weightedScore,
    laceScore,
    laceRiskLevel,
    laceInterpretation,
    guidelineSource,
    guidelineUrl,
    clinicalNotes,
    callTimestamp,
    medications,
    dischargeDate,
    attendingPhysician,
    callStatus,
  } = input;

  // SECTION A — Role and output format
  const sectionA = `You are a clinical documentation AI for a post-discharge triage system. Generate a concise SBAR clinical summary for a nurse to review.

CRITICAL RULES:
1. Output ONLY the SBAR text — no JSON, no preamble, no markdown formatting, no backticks
2. Always cite the specific guideline source for each broken rule — never invent citations. Use the exact guideline name from the clinical evidence section.
3. Never use the patient's name — always say 'the patient'
4. Be concise — maximum 3 sentences per section
5. Use clinical terminology appropriate for a nurse
6. Always end with a clear action for the nurse
7. The Situation section MUST include the ICD-10 condition code AND its display name (e.g., "I10 Hypertensive crisis" or "I50.9 Heart failure unspecified")
8. The Background section MUST state the actual discharge date from the clinical context — never use today's date
9. Use only plain ASCII dashes (-) not em-dashes. No special Unicode characters.
10. NEVER write technical notation in the output — no variable names with underscores (e.g. weight_gain_lbs), no comparison operators (>=, <=, ==, >), no raw rule strings. Use the plain-English descriptions provided in the clinical context.`;

  // SECTION B — Patient clinical context
  const medicationList = medications.length > 0 ? medications.join(", ") : "None recorded";
  const brokenRulesList = brokenRulesNatural.length > 0 ? brokenRulesNatural.join("; ") : "None";
  // Keep raw rules available for internal reference only (not shown to Nova Lite in the prompt body)
  void brokenRules;

  const sectionB = `PATIENT CLINICAL CONTEXT:
Patient ID: ${patientId}
Condition: ${conditionCode} - ${conditionDisplay}
Discharge Date: ${dischargeDate}
Attending Physician: ${attendingPhysician}
Current Medications: ${medicationList}
LACE Score: ${laceScore} (${laceRiskLevel})
LACE Interpretation: ${laceInterpretation}`;

  // SECTION C — Triage result
  const sectionC = `TRIAGE RESULT:
Triage Status: ${triageStatus}
Weighted Score: ${weightedScore}
Broken Rules: ${brokenRulesList}
Call Timestamp: ${callTimestamp}`;

  // SECTION D — Clinical evidence
  const clinicalNotesText =
    clinicalNotes.length > 0
      ? clinicalNotes.map((note) => `  - ${note}`).join("\n")
      : "  - No specific clinical notes available";

  const sectionD = `VALIDATED CLINICAL EVIDENCE FOR BROKEN RULES:
Guideline Source: ${guidelineSource}
Guideline URL: ${guidelineUrl}
Clinical Notes:
${clinicalNotesText}`;

  // SECTION E — SBAR format instruction (all examples use real values — no placeholder brackets)
  const incompleteInstruction = callStatus === "COMPLETE"
    ? `S: Post-discharge follow-up call for patient with ${conditionCode} ${conditionDisplay} completed — partial clinical data collected. Summarize the variables that were captured.\n  A: Incomplete triage assessment — not all monitored variables were captured. Summarize what is known.\n  R: Nurse review of available data required. Attempt to collect missing variables at next contact.`
    : `S: Post-discharge follow-up call for patient with ${conditionCode} ${conditionDisplay} — patient could not be reached\n  A: Insufficient data to perform triage assessment\n  R: Manual telephone follow-up required within 2 hours`;

  const sectionE = `Generate the SBAR summary using exactly this format:

S (Situation): 1-2 sentences. State the ICD-10 code (${conditionCode}) and condition display name (${conditionDisplay}) explicitly, then describe the triage outcome. Example: "Post-discharge follow-up call for patient with ${conditionCode} ${conditionDisplay} reveals ${brokenRulesNatural.length > 0 ? brokenRulesNatural[0] : "no concerning symptoms"}."

B (Background): 2-3 sentences. Use exact discharge date "${dischargeDate}" (do NOT substitute today's date). Include attending physician, current medications, and LACE ${laceScore} (${laceRiskLevel}) readmission risk.

A (Assessment): 2-3 sentences. Describe the clinical concerns in plain English using the descriptions from the Broken Rules section. MUST cite the exact guideline: "${guidelineSource}". Do not omit the guideline citation. Do NOT use underscores, comparison operators, or variable names.

R (Recommendation): 1-2 sentences. Specific action for the nurse. Be direct. Use clinical language.

IMPORTANT: Never write placeholder text such as [ICD-10 code], [condition name], or [guideline source]. Always use the actual values provided above. Never repeat broken rules using technical notation.

For INCOMPLETE triage status:
  ${incompleteInstruction}

For GREEN triage status:
  S: Post-discharge follow-up call for patient with ${conditionCode} ${conditionDisplay} — patient reports no concerning symptoms
  A: All monitored thresholds within normal limits per ${guidelineSource}
  R: No immediate action required - routine follow-up at next scheduled appointment`;

  // SECTION F — Final instruction
  const sectionF = `Now generate the SBAR summary for patient ${patientId}.
Output ONLY the S/B/A/R text. Nothing else.`;

  return [sectionA, sectionB, sectionC, sectionD, sectionE, sectionF].join("\n\n");
}
