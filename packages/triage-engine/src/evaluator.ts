import type { ConditionNode, RuleNode, TriageProtocol, PatientAnswers } from "@sentinel/schemas";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface ConditionResult {
  /** The variable name tested */
  variable: string;
  /** Operator used in the comparison */
  operator: ConditionNode["operator"];
  /** Threshold from the protocol */
  threshold: number | boolean | string;
  /** Patient's actual reported value, undefined if variable was not answered */
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
  /** Variable names whose conditions triggered a non-GREEN outcome */
  brokenRules: string[];
  /** Weighted score from root_node evaluation; undefined when no weights are set */
  weightedScore: number | undefined;
  /** Raw result from evaluating the protocol's root_node */
  nodeResult: NodeResult;
  /** True when the call was incomplete or required variables were unanswered */
  isIncomplete: boolean;
}

// ─── evaluateCondition ────────────────────────────────────────────────────────

/**
 * Compares a single extracted variable value against a protocol condition.
 * Returns `passed: false` when the variable is absent from the answers map.
 */
export function evaluateCondition(
  condition: ConditionNode,
  variables: PatientAnswers["variables"]
): ConditionResult {
  const entry = variables[condition.variable];
  const actualValue = entry?.value;
  const weight = condition.weight ?? 0;

  if (actualValue === undefined) {
    return {
      variable: condition.variable,
      operator: condition.operator,
      threshold: condition.threshold,
      actualValue: undefined,
      weight,
      passed: false,
    };
  }

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
 * - Returns INCOMPLETE when the call did not complete or required variables
 *   listed in `unresolved_variables` are missing.
 * - Returns the protocol's `flag_color` when the root_node passes.
 * - Returns GREEN when the root_node does not pass.
 *
 * @param laceRiskLevel  Optional LACE risk level string — reserved for future
 *                       severity adjustment; not currently applied to flag_color.
 */
export function evaluateProtocol(
  protocol: TriageProtocol,
  answers: PatientAnswers,
  laceRiskLevel?: string
): TriageResult {
  void laceRiskLevel; // reserved parameter — suppresses noUnusedParameters

  // ── Completeness check ───────────────────────────────────────────────────
  const isIncomplete =
    answers.call_status === "INCOMPLETE" ||
    answers.unresolved_variables.length > 0;

  if (isIncomplete) {
    const nodeResult = evaluateNode(protocol.root_node, answers.variables);
    return {
      flagColor: "INCOMPLETE",
      brokenRules: [],
      weightedScore: nodeResult.weightedScore,
      nodeResult,
      isIncomplete: true,
    };
  }

  // ── Evaluate root node ───────────────────────────────────────────────────
  const nodeResult = evaluateNode(protocol.root_node, answers.variables);

  const flagColor: TriageResult["flagColor"] = nodeResult.passed
    ? protocol.flag_color
    : "GREEN";

  const brokenRules: string[] = nodeResult.passed
    ? nodeResult.conditionResults
        .filter((r) => r.passed)
        .map((r) => r.variable)
    : [];

  return {
    flagColor,
    brokenRules,
    weightedScore: nodeResult.weightedScore,
    nodeResult,
    isIncomplete: false,
  };
}
