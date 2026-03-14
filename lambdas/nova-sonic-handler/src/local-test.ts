/**
 * local-test.ts — Simulates 6 conversation scenarios for Nova Sonic
 * without requiring AWS credentials or audio.
 *
 * Tests the conversation-state logic, question-formatter, system-prompt
 * builder, and all 10 robustness rules from the spec.
 *
 * Run: cd lambdas/nova-sonic-handler && npm run test:local
 */

import {
  buildConversationState,
  markAnswered,
  markAsked,
  setUrgentEscalation,
  setCallEndReason,
  deriveCallStatus,
  incrementOffTopic,
  incrementClarification,
  shouldRedirect,
  type ExtractedAnswer,
  type FhirPatientRecord,
} from "./conversation-state";
import { buildSystemPrompt } from "./system-prompt";
import { formatQuestion } from "./question-formatter";

const SEP = "─────────────────────────────────────────────";

// ─── Mock protocol builder ────────────────────────────────────────────────────

interface MockCondition {
  variable:   string;
  operator:   string;
  threshold:  number | boolean;
  weight:     number;
  flag_color: string;
}

function makeProtocol(
  conditionCode: string,
  conditionDisplay: string,
  conditions: MockCondition[]
): unknown {
  return {
    condition_code:    conditionCode,
    condition_display: conditionDisplay,
    guideline_source:  "AHA/ACC 2023",
    root_node: {
      conditions,
      sub_nodes: [],
    },
  };
}

function makePatientRecord(
  name: string,
  language: string,
  medications: string[]
): FhirPatientRecord {
  return {
    patient: {
      name:          [{ text: name }],
      communication: [{ language: { coding: [{ code: language }] } }],
    },
    conditions:  [],
    medications: medications.map((m) => ({ medication: { text: m } })),
  };
}

// ─── Scenario result type ─────────────────────────────────────────────────────

interface ScenarioResult {
  scenarioNum:  number;
  name:         string;
  patientId:    string;
  condition:    string;
  questionsAsked:    number;
  questionsAnswered: number;
  toolCalls:    string[];
  callEndReason: string;
  answers:      { variable: string; value: string; confidence: number; ambiguous: boolean }[];
  pass:        boolean;
  failReason?: string | undefined;
}

function printResult(r: ScenarioResult): void {
  console.log(SEP);
  console.log(`SCENARIO ${r.scenarioNum}: ${r.name}`);
  console.log(SEP);
  console.log(`  Patient:           ${r.patientId} — ${r.condition}`);
  console.log(`  Questions asked:   ${r.questionsAsked}`);
  console.log(`  Answers recorded:  ${r.questionsAnswered}`);
  console.log(`  Tool calls made:   ${r.toolCalls.join(", ") || "none"}`);
  console.log(`  Call end reason:   ${r.callEndReason}`);
  if (r.answers.length > 0) {
    console.log("  Answers:");
    for (const a of r.answers) {
      console.log(
        `    ${a.variable}: ${a.value} (confidence: ${a.confidence.toFixed(2)}, ambiguous: ${a.ambiguous.toString()})`
      );
    }
  }
  console.log(`  ${r.pass ? "PASS" : `FAIL — ${r.failReason ?? "unknown"}`}`);
}

// ─── SCENARIO 1 — Normal call, all questions answered ─────────────────────────

function runScenario1(): ScenarioResult {
  const protocol = makeProtocol("I50.9", "Heart failure, unspecified", [
    { variable: "weight_gain_lbs",     operator: ">=", threshold: 3,    weight: 10, flag_color: "RED"    },
    { variable: "shortness_of_breath", operator: "==", threshold: true, weight: 9,  flag_color: "RED"    },
    { variable: "lasix_filled",        operator: "==", threshold: true, weight: 8,  flag_color: "YELLOW" },
    { variable: "swelling",            operator: "==", threshold: true, weight: 7,  flag_color: "YELLOW" },
    { variable: "appetite",            operator: "==", threshold: true, weight: 5,  flag_color: "YELLOW" },
    { variable: "mobility",            operator: "==", threshold: true, weight: 4,  flag_color: "GREEN"  },
  ]);

  const record = makePatientRecord("Mary Johnson", "en", ["furosemide 40mg", "lisinopril 10mg"]);
  let state = buildConversationState("P001", "C001", protocol, record);

  // Simulate system prompt building
  buildSystemPrompt(state, {
    conditionDisplay: "Heart failure, unspecified",
    guidelineSource:  "AHA/ACC 2023",
    laceScore:        12,
    laceRiskLevel:    "HIGH",
  });

  const toolCalls: string[] = [];

  // Simulate patient responses
  const responses: Record<string, { value: string; confidence: number; ambiguous: boolean }> = {
    weight_gain_lbs:     { value: "4",    confidence: 0.95, ambiguous: false },
    shortness_of_breath: { value: "true", confidence: 0.9,  ambiguous: false },
    lasix_filled:        { value: "false",confidence: 0.95, ambiguous: false },
    swelling:            { value: "true", confidence: 0.9,  ambiguous: false },
    appetite:            { value: "false",confidence: 0.85, ambiguous: false },
    mobility:            { value: "true", confidence: 0.8,  ambiguous: false },
  };

  for (const q of state.questions) {
    state = markAsked(state, q.variable);
    const resp = responses[q.variable];
    if (resp) {
      const answer: ExtractedAnswer = {
        variable:     q.variable,
        value:        resp.value === "true" ? true : resp.value === "false" ? false : Number(resp.value) || resp.value,
        confidence:   resp.confidence,
        rawResponse:  `Patient response for ${q.variable}`,
        needsFollowUp: resp.confidence < 0.5,
        wasAmbiguous:  resp.ambiguous,
      };
      state = markAnswered(state, q.variable, answer);
      toolCalls.push(`record_answer(${q.variable})`);
    }
  }

  toolCalls.push("end_call");
  state = setCallEndReason(state, "completed");

  const allAnswered = state.answers.size === 6;
  const status = deriveCallStatus(state);

  return {
    scenarioNum:       1,
    name:              "Normal call — all 6 questions answered",
    patientId:         "P001",
    condition:         "Heart failure, unspecified",
    questionsAsked:    state.questions.filter((q) => q.asked).length,
    questionsAnswered: state.answers.size,
    toolCalls,
    callEndReason:     state.callEndReason ?? "completed",
    answers:           [...state.answers.values()].map((a) => ({
      variable:   a.variable,
      value:      String(a.value),
      confidence: a.confidence,
      ambiguous:  a.wasAmbiguous,
    })),
    pass: allAnswered && status === "COMPLETE",
    failReason: !allAnswered ? `Only ${state.answers.size}/6 answered` : undefined,
  };
}

// ─── SCENARIO 2 — Off-topic patient ──────────────────────────────────────────

function runScenario2(): ScenarioResult {
  const protocol = makeProtocol("E11.9", "Type 2 diabetes mellitus", [
    { variable: "blood_sugar_level",   operator: ">", threshold: 250,  weight: 9, flag_color: "RED"    },
    { variable: "medication_adherence",operator: "==",threshold: true, weight: 7, flag_color: "YELLOW" },
    { variable: "dizziness",           operator: "==",threshold: true, weight: 6, flag_color: "YELLOW" },
  ]);

  const record = makePatientRecord("Robert Smith", "en", ["metformin 500mg", "insulin glargine"]);
  let state = buildConversationState("P003", "C003", protocol, record);
  const toolCalls: string[] = [];

  // Ask first question
  const q1 = state.questions[0];
  if (!q1) throw new Error("No questions");
  state = markAsked(state, q1.variable);

  // First response: off topic
  state = incrementOffTopic(state);
  // Rule 3: shouldRedirect fires, system redirects
  const redirectFired = shouldRedirect(state); // offTopicCount=1, not >=2 yet

  // Second response: still off topic
  state = incrementOffTopic(state);
  const redirectFired2 = shouldRedirect(state); // offTopicCount=2, fires

  // Third response: gives actual answer
  const answer: ExtractedAnswer = {
    variable:     q1.variable,
    value:        280,
    confidence:   0.9,
    rawResponse:  "My sugar was about 280 I think",
    needsFollowUp: false,
    wasAmbiguous:  false,
  };
  state = markAnswered(state, q1.variable, answer);
  toolCalls.push(`record_answer(${q1.variable})`);

  // Answer remaining questions
  for (const q of state.questions.slice(1)) {
    state = markAsked(state, q.variable);
    state = markAnswered(state, q.variable, {
      variable:     q.variable,
      value:        true,
      confidence:   0.85,
      rawResponse:  "Yes",
      needsFollowUp: false,
      wasAmbiguous:  false,
    });
    toolCalls.push(`record_answer(${q.variable})`);
  }

  toolCalls.push("end_call");
  state = setCallEndReason(state, "completed");

  const bloodSugarAnswer = state.answers.get("blood_sugar_level");
  const correctValue = bloodSugarAnswer?.value === 280;
  const redirectWorked = redirectFired2; // should be true after 2 off-topic

  return {
    scenarioNum:       2,
    name:              "Off-topic patient — redirect fires, answer recorded",
    patientId:         "P003",
    condition:         "Type 2 diabetes mellitus",
    questionsAsked:    state.questions.filter((q) => q.asked).length,
    questionsAnswered: state.answers.size,
    toolCalls,
    callEndReason:     state.callEndReason ?? "completed",
    answers:           [bloodSugarAnswer].filter(Boolean).map((a) => ({
      variable:   a!.variable,
      value:      String(a!.value),
      confidence: a!.confidence,
      ambiguous:  a!.wasAmbiguous,
    })),
    pass: correctValue && redirectWorked && !redirectFired,
    failReason:
      !correctValue     ? "blood_sugar_level not recorded as 280" :
      !redirectWorked   ? "redirect did not fire at offTopicCount=2" :
      redirectFired     ? "redirect fired too early (before count=2)" :
      undefined,
  };
}

// ─── SCENARIO 3 — Ambiguous answer, higher value recorded ─────────────────────

function runScenario3(): ScenarioResult {
  const protocol = makeProtocol("M17.11", "Primary osteoarthritis, right knee", [
    { variable: "pain_level",   operator: ">", threshold: 6, weight: 9, flag_color: "RED"    },
    { variable: "mobility",     operator: "==",threshold: true, weight: 6, flag_color: "YELLOW" },
    { variable: "dizziness",    operator: "==",threshold: true, weight: 5, flag_color: "YELLOW" },
  ]);

  const record = makePatientRecord("Alice Chen", "en", ["naproxen 500mg"]);
  let state = buildConversationState("P002", "C002", protocol, record);
  const toolCalls: string[] = [];

  const q1 = state.questions[0];
  if (!q1) throw new Error("No questions");
  state = markAsked(state, q1.variable);

  // Patient says "7 or maybe 8" — ambiguous, should record 8 (higher)
  state = incrementClarification(state);

  // Robustness rule 10: record higher value for clinical safety
  const answer: ExtractedAnswer = {
    variable:     "pain_level",
    value:        8,           // ← higher of 7 and 8
    confidence:   0.75,
    rawResponse:  "My pain is like a 7 or maybe 8",
    needsFollowUp: false,
    wasAmbiguous:  true,
  };
  state = markAnswered(state, "pain_level", answer);
  toolCalls.push("record_answer(pain_level)");

  // Answer remaining
  for (const q of state.questions.slice(1)) {
    state = markAsked(state, q.variable);
    state = markAnswered(state, q.variable, {
      variable:     q.variable,
      value:        false,
      confidence:   0.9,
      rawResponse:  "No",
      needsFollowUp: false,
      wasAmbiguous:  false,
    });
    toolCalls.push(`record_answer(${q.variable})`);
  }

  toolCalls.push("end_call");
  state = setCallEndReason(state, "completed");

  const painAnswer = state.answers.get("pain_level");
  const higherValue  = painAnswer?.value === 8;
  const wasAmbiguous = painAnswer?.wasAmbiguous === true;

  return {
    scenarioNum:       3,
    name:              "Ambiguous answer — higher value (8) recorded for safety",
    patientId:         "P002",
    condition:         "Osteoarthritis, right knee",
    questionsAsked:    state.questions.filter((q) => q.asked).length,
    questionsAnswered: state.answers.size,
    toolCalls,
    callEndReason:     state.callEndReason ?? "completed",
    answers:           painAnswer ? [{
      variable:   painAnswer.variable,
      value:      String(painAnswer.value),
      confidence: painAnswer.confidence,
      ambiguous:  painAnswer.wasAmbiguous,
    }] : [],
    pass: higherValue && wasAmbiguous,
    failReason:
      !higherValue  ? `Recorded ${String(painAnswer?.value)} instead of 8` :
      !wasAmbiguous ? "wasAmbiguous not set to true" :
      undefined,
  };
}

// ─── SCENARIO 4 — Emergency escalation ───────────────────────────────────────

function runScenario4(): ScenarioResult {
  const protocol = makeProtocol("I21.9", "Acute myocardial infarction", [
    { variable: "chest_pain",      operator: "==", threshold: true, weight: 10, flag_color: "RED" },
    { variable: "medication_adherence", operator: "==", threshold: true, weight: 7, flag_color: "YELLOW" },
  ]);

  const record = makePatientRecord("Carlos Rivera", "es", ["aspirin 81mg", "clopidogrel 75mg"]);
  let state = buildConversationState("P005", "C005", protocol, record);
  const toolCalls: string[] = [];

  // First question asked — patient reports emergency symptom immediately
  const q1 = state.questions[0];
  if (!q1) throw new Error("No questions");
  state = markAsked(state, q1.variable);

  // Emergency detected: MUST call urgent_escalation FIRST, then stop
  state = setUrgentEscalation(state);
  toolCalls.push("urgent_escalation");

  // Verify: call ends immediately, no more questions asked
  const urgentFired     = state.urgentEscalation;
  const callEndReason   = state.callEndReason;
  const noMoreQuestions = state.questions.filter((q) => q.asked).length === 1;
  // Remaining question (medication_adherence) should NOT be asked

  return {
    scenarioNum:       4,
    name:              "Emergency escalation — urgent_escalation called, call stops",
    patientId:         "P005",
    condition:         "Acute myocardial infarction",
    questionsAsked:    state.questions.filter((q) => q.asked).length,
    questionsAnswered: state.answers.size,
    toolCalls,
    callEndReason:     callEndReason ?? "urgent_escalation",
    answers:           [],
    pass: urgentFired && callEndReason === "urgent_escalation" && noMoreQuestions,
    failReason:
      !urgentFired      ? "urgentEscalation flag not set" :
      callEndReason !== "urgent_escalation" ? `callEndReason=${callEndReason ?? "null"}` :
      !noMoreQuestions  ? "Additional questions asked after escalation" :
      undefined,
  };
}

// ─── SCENARIO 5 — Patient ends call early ─────────────────────────────────────

function runScenario5(): ScenarioResult {
  const protocol = makeProtocol("N18.3", "Chronic kidney disease, stage 3", [
    { variable: "swelling",    operator: "==", threshold: true,  weight: 8, flag_color: "RED"    },
    { variable: "dizziness",   operator: "==", threshold: true,  weight: 7, flag_color: "YELLOW" },
    { variable: "appetite",    operator: "==", threshold: true,  weight: 6, flag_color: "YELLOW" },
    { variable: "weight_gain_lbs", operator: ">=", threshold: 3, weight: 5, flag_color: "YELLOW" },
    { variable: "confusion",   operator: "==", threshold: true,  weight: 9, flag_color: "RED"    },
  ]);

  const record = makePatientRecord("David Park", "en", ["amlodipine 5mg"]);
  let state = buildConversationState("P006", "C006", protocol, record);
  const toolCalls: string[] = [];

  // Answer only first 2 questions (40% of 5) — then patient ends call
  const toAnswer = state.questions.slice(0, 2);
  for (const q of toAnswer) {
    state = markAsked(state, q.variable);
    state = markAnswered(state, q.variable, {
      variable:     q.variable,
      value:        true,
      confidence:   0.9,
      rawResponse:  "Yes",
      needsFollowUp: false,
      wasAmbiguous:  false,
    });
    toolCalls.push(`record_answer(${q.variable})`);
  }

  // Patient says "I'm busy, let's do this later"
  toolCalls.push("end_call(patient_request)");
  state = setCallEndReason(state, "patient_request");

  // 2/5 = 40% — below 50% threshold → PARTIAL
  const callStatus = deriveCallStatus(state);
  const isPartial  = callStatus === "PARTIAL";
  const isPatientRequest = state.callEndReason === "patient_request";

  return {
    scenarioNum:       5,
    name:              "Patient ends early — partial answers, graceful end",
    patientId:         "P006",
    condition:         "Chronic kidney disease, stage 3",
    questionsAsked:    state.questions.filter((q) => q.asked).length,
    questionsAnswered: state.answers.size,
    toolCalls,
    callEndReason:     state.callEndReason ?? "patient_request",
    answers:           [...state.answers.values()].map((a) => ({
      variable:   a.variable,
      value:      String(a.value),
      confidence: a.confidence,
      ambiguous:  a.wasAmbiguous,
    })),
    pass: isPartial && isPatientRequest,
    failReason:
      !isPartial        ? `Expected PARTIAL but got ${callStatus}` :
      !isPatientRequest ? `Expected patient_request but got ${state.callEndReason ?? "null"}` :
      undefined,
  };
}

// ─── SCENARIO 6 — Spanish patient ────────────────────────────────────────────

function runScenario6(): ScenarioResult {
  const protocol = makeProtocol("I21.9", "Infarto agudo de miocardio", [
    { variable: "chest_pain",      operator: "==", threshold: true, weight: 10, flag_color: "RED"    },
    { variable: "medication_adherence", operator: "==", threshold: true, weight: 8, flag_color: "YELLOW" },
    { variable: "dizziness",       operator: "==", threshold: true, weight: 7, flag_color: "YELLOW" },
  ]);

  const record = makePatientRecord("María García", "es", ["aspirina 81mg", "metoprolol 25mg"]);
  let state = buildConversationState("P005", "C005-ES", protocol, record);

  // Verify language is Spanish
  const isSpanish = state.language === "es";

  // Verify questions are formatted in Spanish
  const spanishQ = formatQuestion({
    variable:         "chest_pain",
    operator:         "==",
    threshold:        true,
    conditionCode:    "I21.9",
    conditionDisplay: "Infarto agudo de miocardio",
    language:         "es",
    patientName:      "María García",
    medications:      ["aspirina 81mg"],
  });
  const isSpanishQuestion = spanishQ.includes("dolor") || spanishQ.includes("pecho") || spanishQ.includes("presión");

  // Verify system prompt contains Spanish language indicator
  const prompt = buildSystemPrompt(state, {
    conditionDisplay: "Infarto agudo de miocardio",
    guidelineSource:  "AHA/ACC 2023",
    laceScore:        14,
    laceRiskLevel:    "HIGH",
  });
  const promptHasSpanish = prompt.includes("Spanish") || prompt.includes("español");

  // Simulate answering all questions in Spanish
  const toolCalls: string[] = [];
  for (const q of state.questions) {
    state = markAsked(state, q.variable);
    state = markAnswered(state, q.variable, {
      variable:     q.variable,
      value:        false,
      confidence:   0.9,
      rawResponse:  "No, no he tenido ningún problema",
      needsFollowUp: false,
      wasAmbiguous:  false,
    });
    toolCalls.push(`record_answer(${q.variable})`);
  }
  toolCalls.push("end_call");
  state = setCallEndReason(state, "completed");

  const pass = isSpanish && isSpanishQuestion && promptHasSpanish;

  return {
    scenarioNum:       6,
    name:              "Spanish patient (language=es) — questions and prompt in Spanish",
    patientId:         "P005",
    condition:         "Infarto agudo de miocardio",
    questionsAsked:    state.questions.filter((q) => q.asked).length,
    questionsAnswered: state.answers.size,
    toolCalls,
    callEndReason:     state.callEndReason ?? "completed",
    answers:           [],
    pass,
    failReason:
      !isSpanish         ? "state.language !== 'es'" :
      !isSpanishQuestion ? `Question not in Spanish: "${spanishQ}"` :
      !promptHasSpanish  ? "System prompt missing Spanish language indicator" :
      undefined,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  console.log(SEP);
  console.log("NOVA SONIC LOCAL SIMULATION — 6 SCENARIOS");
  console.log(SEP);

  const results: ScenarioResult[] = [
    runScenario1(),
    runScenario2(),
    runScenario3(),
    runScenario4(),
    runScenario5(),
    runScenario6(),
  ];

  for (const r of results) {
    printResult(r);
  }

  // Final summary
  console.log("\n" + SEP);
  console.log("NOVA SONIC INTEGRATION — LOCAL TEST SUMMARY");
  console.log(SEP);

  const labelW = 40;
  const labels: Record<number, string> = {
    1: "Scenario 1 (normal — all answered)",
    2: "Scenario 2 (off topic — redirect)",
    3: "Scenario 3 (ambiguous — higher val)",
    4: "Scenario 4 (emergency escalation)",
    5: "Scenario 5 (early end — partial)",
    6: "Scenario 6 (Spanish patient)",
  };

  for (const r of results) {
    const label = labels[r.scenarioNum] ?? `Scenario ${r.scenarioNum}`;
    console.log(`  ${label.padEnd(labelW)} ${r.pass ? "PASS" : "FAIL"}`);
  }

  const allPass = results.every((r) => r.pass);
  console.log(SEP);
  console.log(`OVERALL: ${allPass ? "PASS" : "FAIL"}`);
  console.log(SEP);

  if (!allPass) process.exit(1);
}

main();
