import { evaluateCondition, evaluateNode, evaluateProtocol } from "../evaluator";
import type { TriageProtocol, PatientAnswers } from "@sentinel/schemas";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAnswers(
  vars: Record<string, { value: number | boolean; confidence: number }>,
  status: "COMPLETE" | "INCOMPLETE" = "COMPLETE"
): PatientAnswers {
  return {
    call_id: "TEST-CALL",
    patient_id: "TEST-PATIENT",
    variables: vars,
    unresolved_variables: [],
    transcript_warnings: [],
    call_status: status,
  };
}

type ConditionInput = {
  variable: string;
  operator: string;
  threshold: number | boolean;
  weight: number;
  flag_color?: string;
};

function makeProtocol(
  conditions: ConditionInput[],
  logic: "AND" | "OR" = "OR"
): TriageProtocol {
  // Derive the protocol-level flag_color from the first condition so that
  // the expected colour is reachable when that condition fires.
  const firstColor = conditions[0]?.flag_color ?? "YELLOW";
  const protocolFlagColor = firstColor === "RED" || firstColor === "YELLOW" || firstColor === "GREEN"
    ? firstColor as "RED" | "YELLOW" | "GREEN"
    : "YELLOW";

  return {
    patient_id: "TEST-PATIENT",
    preferred_language: "en",
    flag_color: protocolFlagColor,
    question_priority: conditions.map((c) => c.variable),
    root_node: {
      logic,
      conditions: conditions.map((c) => ({
        variable: c.variable,
        operator: c.operator as TriageProtocol["root_node"]["conditions"][number]["operator"],
        threshold: c.threshold,
        weight: c.weight,
      })),
      weighted_threshold: 0.5,
    },
  };
}

// ─── GROUP 1: evaluateCondition ───────────────────────────────────────────────

describe("evaluateCondition", () => {
  test("Test 1 — weight gain above threshold triggers", () => {
    const result = evaluateCondition(
      { variable: "weight_gain_lbs", operator: ">=", threshold: 3, weight: 0.9 },
      makeAnswers({ weight_gain_lbs: { value: 4, confidence: 0.95 } }).variables
    );
    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe(4);
  });

  test("Test 2 — weight gain below threshold does not trigger", () => {
    const result = evaluateCondition(
      { variable: "weight_gain_lbs", operator: ">=", threshold: 3, weight: 0.9 },
      makeAnswers({ weight_gain_lbs: { value: 2, confidence: 0.95 } }).variables
    );
    expect(result.passed).toBe(false);
    expect(result.actualValue).toBe(2);
  });

  test("Test 3 — boolean true matches == true", () => {
    const result = evaluateCondition(
      { variable: "shortness_of_breath", operator: "==", threshold: true, weight: 0.8 },
      makeAnswers({ shortness_of_breath: { value: true, confidence: 0.90 } }).variables
    );
    expect(result.passed).toBe(true);
  });

  test("Test 4 — boolean false does not match == true", () => {
    const result = evaluateCondition(
      { variable: "shortness_of_breath", operator: "==", threshold: true, weight: 0.8 },
      makeAnswers({ shortness_of_breath: { value: false, confidence: 0.90 } }).variables
    );
    expect(result.passed).toBe(false);
  });

  test("Test 5 — missing variable is skipped", () => {
    const result = evaluateCondition(
      { variable: "weight_gain_lbs", operator: ">=", threshold: 3, weight: 0.9 },
      makeAnswers({}).variables // empty variables
    );
    expect(result.actualValue).toBeUndefined();
    expect(result.passed).toBe(false);
  });

  test("Test 6 — low confidence variable is skipped (value 5 would trigger if high enough)", () => {
    const result = evaluateCondition(
      { variable: "weight_gain_lbs", operator: ">=", threshold: 3, weight: 0.9 },
      makeAnswers({ weight_gain_lbs: { value: 5, confidence: 0.50 } }).variables
    );
    // confidence 0.50 < 0.70 threshold → treated as absent
    expect(result.actualValue).toBeUndefined();
    expect(result.passed).toBe(false);
  });

  test("Test 7 — boundary value exactly at threshold triggers", () => {
    const result = evaluateCondition(
      { variable: "pain_level", operator: ">=", threshold: 7, weight: 0.7 },
      makeAnswers({ pain_level: { value: 7, confidence: 0.92 } }).variables
    );
    expect(result.passed).toBe(true);
  });

  test("Test 8 — boundary value one below threshold does not trigger", () => {
    const result = evaluateCondition(
      { variable: "pain_level", operator: ">=", threshold: 7, weight: 0.7 },
      makeAnswers({ pain_level: { value: 6, confidence: 0.92 } }).variables
    );
    expect(result.passed).toBe(false);
  });
});

// ─── GROUP 2: evaluateNode ────────────────────────────────────────────────────

describe("evaluateNode", () => {
  test("Test 9 — OR node triggers when one condition triggered", () => {
    // weights 0.9 → weighted_threshold path; single pass exceeds 0.5
    const protocol = makeProtocol([
      { variable: "a", operator: ">=", threshold: 5, weight: 0.9, flag_color: "RED" },
      { variable: "b", operator: ">=", threshold: 5, weight: 0.9, flag_color: "RED" },
    ], "OR");
    const vars = makeAnswers({
      a: { value: 6, confidence: 0.95 },
      b: { value: 3, confidence: 0.95 },
    }).variables;
    const result = evaluateNode(protocol.root_node, vars);
    expect(result.passed).toBe(true);
    const triggeredRules = result.conditionResults.filter((r) => r.passed);
    expect(triggeredRules).toHaveLength(1);
  });

  test("Test 10 — OR node does not trigger when nothing triggers", () => {
    const protocol = makeProtocol([
      { variable: "a", operator: ">=", threshold: 5, weight: 0.9, flag_color: "RED" },
      { variable: "b", operator: ">=", threshold: 5, weight: 0.9, flag_color: "RED" },
    ], "OR");
    const vars = makeAnswers({
      a: { value: 2, confidence: 0.95 },
      b: { value: 2, confidence: 0.95 },
    }).variables;
    const result = evaluateNode(protocol.root_node, vars);
    expect(result.passed).toBe(false);
    const triggeredRules = result.conditionResults.filter((r) => r.passed);
    expect(triggeredRules).toHaveLength(0);
  });

  test("Test 11 — AND node triggers when all conditions trigger", () => {
    // weight: 0 → hasWeights=false → weightedScore=undefined → AND branch runs
    const protocol = makeProtocol([
      { variable: "a", operator: ">=", threshold: 5, weight: 0, flag_color: "YELLOW" },
      { variable: "b", operator: ">=", threshold: 5, weight: 0, flag_color: "YELLOW" },
    ], "AND");
    const vars = makeAnswers({
      a: { value: 6, confidence: 0.95 },
      b: { value: 6, confidence: 0.95 },
    }).variables;
    const result = evaluateNode(protocol.root_node, vars);
    expect(result.passed).toBe(true);
    const triggeredRules = result.conditionResults.filter((r) => r.passed);
    expect(triggeredRules).toHaveLength(2);
  });

  test("Test 12 — AND node does not trigger when one condition fails", () => {
    const protocol = makeProtocol([
      { variable: "a", operator: ">=", threshold: 5, weight: 0, flag_color: "YELLOW" },
      { variable: "b", operator: ">=", threshold: 5, weight: 0, flag_color: "YELLOW" },
    ], "AND");
    const vars = makeAnswers({
      a: { value: 6, confidence: 0.95 },
      b: { value: 3, confidence: 0.95 },
    }).variables;
    const result = evaluateNode(protocol.root_node, vars);
    expect(result.passed).toBe(false);
  });

  test("Test 13 — all skipped means not triggered", () => {
    // weight: 0 → OR branch runs (no weighted path)
    const protocol = makeProtocol([
      { variable: "a", operator: ">=", threshold: 5, weight: 0, flag_color: "YELLOW" },
      { variable: "b", operator: ">=", threshold: 5, weight: 0, flag_color: "YELLOW" },
    ], "OR");
    const vars = makeAnswers({}).variables; // empty
    const result = evaluateNode(protocol.root_node, vars);
    expect(result.passed).toBe(false);
    const skippedVariables = result.conditionResults.filter((r) => r.actualValue === undefined);
    expect(skippedVariables).toHaveLength(2);
  });
});

// ─── GROUP 3: evaluateProtocol ────────────────────────────────────────────────

describe("evaluateProtocol", () => {
  test("Test 14 — INCOMPLETE call status returns immediately", () => {
    const protocol = makeProtocol([
      { variable: "weight_gain_lbs", operator: ">=", threshold: 3, weight: 0.9 },
    ]);
    const result = evaluateProtocol(protocol, makeAnswers({}, "INCOMPLETE"));
    expect(result.flagColor).toBe("INCOMPLETE");
    expect(result.incompleteReason).toBe("Call did not complete");
    expect(result.brokenRules).toEqual([]);
    expect(result.isIncomplete).toBe(true);

    // Also cover the unresolved_variables branch
    const withUnresolved: PatientAnswers = {
      ...makeAnswers({}),
      unresolved_variables: ["missing_var"],
    };
    const result2 = evaluateProtocol(protocol, withUnresolved);
    expect(result2.flagColor).toBe("INCOMPLETE");
    expect(result2.incompleteReason).toBe("Call did not complete");
  });

  test("Test 15 — RED condition triggered returns RED", () => {
    const protocol = makeProtocol([
      { variable: "chest_pain", operator: "==", threshold: true, weight: 0.9, flag_color: "RED" },
    ], "OR");
    const answers = makeAnswers({ chest_pain: { value: true, confidence: 0.95 } });
    const result = evaluateProtocol(protocol, answers);
    expect(result.flagColor).toBe("RED");
    expect(result.brokenRules).toContain("chest_pain == true");
  });

  test("Test 16 — YELLOW only condition returns YELLOW", () => {
    const protocol = makeProtocol([
      { variable: "pain_level", operator: ">=", threshold: 7, weight: 0.7, flag_color: "YELLOW" },
    ], "OR");
    const answers = makeAnswers({ pain_level: { value: 8, confidence: 0.90 } });
    const result = evaluateProtocol(protocol, answers);
    expect(result.flagColor).toBe("YELLOW");
  });

  test("Test 17 — nothing triggered returns GREEN", () => {
    const protocol = makeProtocol([
      { variable: "blood_sugar_level", operator: ">=", threshold: 300, weight: 0.9, flag_color: "RED" },
    ], "OR");
    const answers = makeAnswers({ blood_sugar_level: { value: 150, confidence: 0.90 } });
    const result = evaluateProtocol(protocol, answers);
    expect(result.flagColor).toBe("GREEN");
    expect(result.brokenRules).toEqual([]);
    expect(result.weightedScore).toBe(0);
  });

  test("Test 18 — P001 CHF full scenario", () => {
    // weight_gain (RED) is conditions[0] → protocol.flag_color = RED
    const protocol = makeProtocol([
      { variable: "weight_gain_lbs",     operator: ">=", threshold: 3,     weight: 0.9, flag_color: "RED"    },
      { variable: "shortness_of_breath", operator: "==", threshold: true,  weight: 0.8, flag_color: "RED"    },
      { variable: "lasix_filled",        operator: "==", threshold: false,  weight: 0.7, flag_color: "YELLOW" },
    ], "OR");
    const answers = makeAnswers({
      weight_gain_lbs:     { value: 4,     confidence: 0.95 },
      shortness_of_breath: { value: false,  confidence: 0.90 },
      lasix_filled:        { value: false,  confidence: 0.88 },
      ankle_swelling:      { value: true,   confidence: 0.85 },
    });
    const result = evaluateProtocol(protocol, answers);
    expect(result.flagColor).toBe("RED");
    expect(result.brokenRules).toContain("weight_gain_lbs >= 3");
    expect(result.brokenRules).toContain("lasix_filled == false");
    expect(result.brokenRules).not.toContain("shortness_of_breath == true");
  });

  test("Test 19 — P002 knee scenario returns YELLOW not RED", () => {
    // pain_level (YELLOW) is conditions[0] → protocol.flag_color = YELLOW
    const protocol = makeProtocol([
      { variable: "pain_level",      operator: ">=", threshold: 7,    weight: 0.7, flag_color: "YELLOW" },
      { variable: "fever",           operator: ">=", threshold: 101,  weight: 0.9, flag_color: "RED"    },
      { variable: "wound_drainage",  operator: "==", threshold: true, weight: 0.8, flag_color: "RED"    },
    ], "OR");
    const answers = makeAnswers({
      pain_level:     { value: 7,     confidence: 0.92 },
      fever:          { value: 98.6,  confidence: 0.90 },
      wound_drainage: { value: false,  confidence: 0.88 },
    });
    const result = evaluateProtocol(protocol, answers);
    expect(result.flagColor).toBe("YELLOW");
    expect(result.brokenRules).toContain("pain_level >= 7");
    expect(result.brokenRules).not.toContain("fever >= 101");
  });

  test("Test 20 — P003 diabetes scenario returns GREEN", () => {
    const protocol = makeProtocol([
      { variable: "blood_sugar_level",     operator: ">=", threshold: 300,  weight: 0.9, flag_color: "RED"    },
      { variable: "medication_adherence",  operator: "==", threshold: false, weight: 0.7, flag_color: "YELLOW" },
      { variable: "dizziness",             operator: "==", threshold: true,  weight: 0.6, flag_color: "YELLOW" },
    ], "OR");
    const answers = makeAnswers({
      blood_sugar_level:    { value: 180,  confidence: 0.90 },
      medication_adherence: { value: true,  confidence: 0.95 },
      dizziness:            { value: false, confidence: 0.90 },
    });
    const result = evaluateProtocol(protocol, answers);
    expect(result.flagColor).toBe("GREEN");
    expect(result.brokenRules).toEqual([]);
    expect(result.weightedScore).toBe(0);
  });

  test("Test 21 — HIGH LACE patient triggers INCOMPLETE at 30% skipped threshold (4/6 skipped)", () => {
    const protocol = makeProtocol([
      { variable: "q1", operator: ">=", threshold: 5, weight: 0.9, flag_color: "RED" },
      { variable: "q2", operator: ">=", threshold: 5, weight: 0.9, flag_color: "RED" },
      { variable: "q3", operator: ">=", threshold: 5, weight: 0.9, flag_color: "RED" },
      { variable: "q4", operator: ">=", threshold: 5, weight: 0.9, flag_color: "RED" },
      { variable: "q5", operator: ">=", threshold: 5, weight: 0.9, flag_color: "RED" },
      { variable: "q6", operator: ">=", threshold: 5, weight: 0.9, flag_color: "RED" },
    ], "OR");
    // Only q1 and q2 answered → 4/6 skipped = 67% > 30% HIGH threshold
    const answers = makeAnswers({
      q1: { value: 6, confidence: 0.95 },
      q2: { value: 6, confidence: 0.95 },
    });
    const result = evaluateProtocol(protocol, answers, "HIGH");
    expect(result.flagColor).toBe("INCOMPLETE");
    expect(result.isIncomplete).toBe(true);
    expect(result.incompleteReason).toContain("4/6");
  });

  test("Test 22 — LOW LACE patient does NOT trigger INCOMPLETE at 33% skipped (below 50% threshold)", () => {
    const protocol = makeProtocol([
      { variable: "q1", operator: ">=", threshold: 5, weight: 0.9, flag_color: "YELLOW" },
      { variable: "q2", operator: ">=", threshold: 5, weight: 0.9, flag_color: "YELLOW" },
      { variable: "q3", operator: ">=", threshold: 5, weight: 0.9, flag_color: "YELLOW" },
      { variable: "q4", operator: ">=", threshold: 5, weight: 0.9, flag_color: "YELLOW" },
      { variable: "q5", operator: ">=", threshold: 5, weight: 0.9, flag_color: "YELLOW" },
      { variable: "q6", operator: ">=", threshold: 5, weight: 0.9, flag_color: "YELLOW" },
    ], "OR");
    // 4 answered, 2 skipped = 33% < 50% LOW threshold → should NOT be INCOMPLETE
    const answers = makeAnswers({
      q1: { value: 6, confidence: 0.95 },
      q2: { value: 6, confidence: 0.95 },
      q3: { value: 3, confidence: 0.95 },
      q4: { value: 3, confidence: 0.95 },
    });
    const result = evaluateProtocol(protocol, answers, "LOW");
    expect(result.flagColor).not.toBe("INCOMPLETE");
    expect(result.isIncomplete).toBe(false);
  });
});
