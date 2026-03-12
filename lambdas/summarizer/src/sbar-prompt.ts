import { type DashboardPayload } from "@sentinel/schemas";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SbarPromptInput {
  patientId: string;
  conditionCode: string;
  conditionDisplay: string;
  triageStatus: DashboardPayload["triage_status"];
  brokenRules: string[];
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
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

export function buildSbarPrompt(input: SbarPromptInput): string {
  const {
    patientId,
    conditionCode,
    conditionDisplay,
    triageStatus,
    brokenRules,
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
  } = input;

  // SECTION A — Role and output format
  const sectionA = `You are a clinical documentation AI for a post-discharge triage system. Generate a concise SBAR clinical summary for a nurse to review.

CRITICAL RULES:
1. Output ONLY the SBAR text — no JSON, no preamble, no markdown formatting, no backticks
2. Always cite the guideline source for each broken rule — never invent citations
3. Never use the patient's name — always say 'the patient'
4. Be concise — maximum 3 sentences per section
5. Use clinical terminology appropriate for a nurse
6. Always end with a clear action for the nurse`;

  // SECTION B — Patient clinical context
  const medicationList = medications.length > 0 ? medications.join(", ") : "None recorded";
  const brokenRulesList = brokenRules.length > 0 ? brokenRules.join(", ") : "None";

  const sectionB = `PATIENT CLINICAL CONTEXT:
Patient ID: ${patientId}
Condition: ${conditionCode} — ${conditionDisplay}
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

  // SECTION E — SBAR format instruction
  const sectionE = `Generate the SBAR summary using exactly this format:

S (Situation): [1-2 sentences — what is happening right now with this patient]

B (Background): [2-3 sentences — patient condition, discharge date, attending physician, medications]

A (Assessment): [2-3 sentences — which clinical thresholds were exceeded and the clinical significance. MUST cite the guideline source for each broken rule using the evidence above. Example: 'per AHA Heart Failure Guidelines 2022']

R (Recommendation): [1-2 sentences — specific action for the nurse. Be direct. Use clinical language.]

For INCOMPLETE status:
  S: Patient could not be reached after call attempts
  A: Insufficient data to perform triage assessment
  R: Manual telephone follow-up required within 2 hours

For GREEN status:
  S: Patient reports no concerning symptoms
  A: All monitored thresholds within normal limits
  R: No immediate action required — routine follow-up at next scheduled appointment`;

  // SECTION F — Final instruction
  const sectionF = `Now generate the SBAR summary for patient ${patientId}.
Output ONLY the S/B/A/R text. Nothing else.`;

  return [sectionA, sectionB, sectionC, sectionD, sectionE, sectionF].join("\n\n");
}
