import type { ConditionNode, RuleNode, TriageProtocol, PatientAnswers } from "@sentinel/schemas";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum answer confidence to treat a variable as present. */
const CONFIDENCE_THRESHOLD = 0.7;

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface ConditionResult {
  /** The variable name tested */
  variable: string;
  /** Operator used in the comparison */
  operator: ConditionNode["operator"];
  /** Threshold from the protocol */
  threshold: number | boolean | string;
  /** Patient's actual reported value, undefined if variable was absent or low-confidence */
  actualValue: number | boolean | string | undefined;
  /** Weight contribution of this condition (0 if weight not set) */
  weight: number;
  /** Whether the condition evaluated to true */
  passed: boolean;
}

export interface NodeResult {
  /** Whether the node as a whole passed (AND/OR logic applied) */
  passed: boolean;
  /** Weighted sum of passed condition weights; undefined when no weights are set */
  weightedScore: number | undefined;
  /** Individual condition results */
  conditionResults: ConditionResult[];
}

export interface TriageResult {
  /** Final triage colour, or INCOMPLETE when call data is insufficient */
  flagColor: "GREEN" | "YELLOW" | "RED" | "INCOMPLETE";
  /** Formatted broken-rule strings, e.g. "weight_gain_lbs >= 3" */
  brokenRules: string[];
  /** Weighted score from root_node evaluation; undefined when no weights are set */
  weightedScore: number | undefined;
  /** Raw result from evaluating the protocol's root_node */
  nodeResult: NodeResult;
  /** True when the call was incomplete or required variables were unanswered */
  isIncomplete: boolean;
  /** Human-readable reason when isIncomplete is true */
  incompleteReason?: string;
}

// ─── evaluateCondition ────────────────────────────────────────────────────────

/**
 * Compares a single extracted variable value against a protocol condition.
 * Returns `passed: false` (with actualValue undefined) when the variable is
 * absent from the answers map or has confidence below CONFIDENCE_THRESHOLD.
 */
export function evaluateCondition(
  condition: ConditionNode,
  variables: PatientAnswers["variables"]
): ConditionResult {
  const entry = variables[condition.variable];
  const weight = condition.weight ?? 0;

  // Skip absent variables and low-confidence answers
  if (entry === undefined || entry.confidence < CONFIDENCE_THRESHOLD) {
    return {
      variable: condition.variable,
      operator: condition.operator,
      threshold: condition.threshold,
      actualValue: undefined,
      weight,
      passed: false,
    };
  }

  const actualValue = entry.value;
  let passed = false;

  // Numeric comparisons
  if (typeof actualValue === "number" && typeof condition.threshold === "number") {
    switch (condition.operator) {
      case ">=": passed = actualValue >= condition.threshold; break;
      case "<=": passed = actualValue <= condition.threshold; break;
      case ">":  passed = actualValue >  condition.threshold; break;
      case "<":  passed = actualValue <  condition.threshold; break;
      case "==": passed = actualValue === condition.threshold; break;
    }
  } else if (typeof actualValue === "boolean" && typeof condition.threshold === "boolean") {
    passed = condition.operator === "==" ? actualValue === condition.threshold : false;
  } else {
    // String / mixed: only equality is meaningful
    passed = condition.operator === "==" ? String(actualValue) === String(condition.threshold) : false;
  }

  return {
    variable: condition.variable,
    operator: condition.operator,
    threshold: condition.threshold,
    actualValue,
    weight,
    passed,
  };
}

// ─── evaluateNode ─────────────────────────────────────────────────────────────

/**
 * Evaluates a RuleNode (which may contain conditions with weights).
 *
 * - AND logic: node passes when ALL conditions pass
 * - OR  logic: node passes when ANY condition passes
 * - Weighted threshold: if set, node passes when sum-of-passed-weights >= threshold
 */
export function evaluateNode(
  node: RuleNode,
  variables: PatientAnswers["variables"]
): NodeResult {
  const conditionResults = node.conditions.map((c) => evaluateCondition(c, variables));

  // Compute weighted score when any condition carries a weight
  const hasWeights = conditionResults.some((r) => r.weight > 0);
  const weightedScore: number | undefined = hasWeights
    ? conditionResults
        .filter((r) => r.passed)
        .reduce((sum, r) => sum + r.weight, 0)
    : undefined;

  let passed: boolean;

  if (node.weighted_threshold !== undefined && weightedScore !== undefined) {
    passed = weightedScore >= node.weighted_threshold;
  } else if (node.logic === "AND") {
    passed = conditionResults.every((r) => r.passed);
  } else {
    // OR
    passed = conditionResults.some((r) => r.passed);
  }

  return { passed, weightedScore, conditionResults };
}

// ─── evaluateProtocol ─────────────────────────────────────────────────────────

/**
 * Evaluates a full TriageProtocol against a set of PatientAnswers.
 *
 * Completeness is checked in two stages:
 *   1. Hard stop — call_status INCOMPLETE or unresolved_variables present.
 *   2. LACE skip threshold — when laceRiskLevel is supplied, the fraction of
 *      unanswered question_priority variables is checked against a risk-adjusted
 *      threshold (HIGH: 30 %, MODERATE: 40 %, LOW/other: 50 %).
 *
 * Returns the protocol's `flag_color` when the root_node passes, GREEN otherwise.
 */
export function evaluateProtocol(
  protocol: TriageProtocol,
  answers: PatientAnswers,
  laceRiskLevel?: string
): TriageResult {
  // ── Stage 1: hard completeness stop ─────────────────────────────────────
  // Only trigger on call_status=INCOMPLETE (call was dropped/never connected).
  // Unresolved variables (asked but unanswered) are handled by the LACE skip
  // threshold in Stage 2 — they count as skipped variables there.
  const isHardIncomplete = answers.call_status === "INCOMPLETE";

  if (isHardIncomplete) {
    const nodeResult = evaluateNode(protocol.root_node, answers.variables);
    return {
      flagColor: "INCOMPLETE",
      brokenRules: [],
      weightedScore: nodeResult.weightedScore,
      nodeResult,
      isIncomplete: true,
      incompleteReason: "Call did not complete",
    };
  }

  // ── Stage 2: LACE-adjusted skip threshold ───────────────────────────────
  if (laceRiskLevel !== undefined) {
    const skipThreshold =
      laceRiskLevel === "HIGH"     ? 0.30 :
      laceRiskLevel === "MODERATE" ? 0.40 :
      0.50; // LOW or unrecognised

    const questionCount = protocol.question_priority.length;
    const skippedCount = protocol.question_priority.filter((v) => {
      const entry = answers.variables[v];
      return entry === undefined || entry.confidence < CONFIDENCE_THRESHOLD;
    }).length;

    if (questionCount > 0 && skippedCount / questionCount > skipThreshold) {
      const nodeResult = evaluateNode(protocol.root_node, answers.variables);
      return {
        flagColor: "INCOMPLETE",
        brokenRules: [],
        weightedScore: nodeResult.weightedScore,
        nodeResult,
        isIncomplete: true,
        incompleteReason: `${skippedCount}/${questionCount} required variables were not answered`,
      };
    }
  }

  // ── Evaluate root node ───────────────────────────────────────────────────
  const nodeResult = evaluateNode(protocol.root_node, answers.variables);

  const flagColor: TriageResult["flagColor"] = nodeResult.passed
    ? protocol.flag_color
    : "GREEN";

  const brokenRules: string[] = nodeResult.passed
    ? nodeResult.conditionResults
        .filter((r) => r.passed)
        .map((r) => `${r.variable} ${r.operator} ${r.threshold}`)
    : [];

  return {
    flagColor,
    brokenRules,
    weightedScore: nodeResult.weightedScore,
    nodeResult,
    isIncomplete: false,
  };
}
