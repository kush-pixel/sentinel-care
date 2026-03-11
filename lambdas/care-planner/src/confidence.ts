// Pure TypeScript — zero AWS imports, zero side effects.

export interface ConfidenceInput {
  conditionCode: string;
  rulesFound: boolean;
  conditionCount: number;
  fhirRecordComplete: boolean;
  zodValidationPassed: boolean;
  usedFallback: boolean;
  laceScore?: number;
  laceRiskLevel?: string;
}

export interface ConfidenceResult {
  score: number;
  autoApprove: boolean;
  reasons: string[];
}

export function scoreConfidence(input: ConfidenceInput): ConfidenceResult {
  let score = 0.50;
  const reasons: string[] = [];

  if (input.rulesFound) {
    score += 0.30;
    reasons.push("Thresholds sourced from validated library");
  } else {
    score -= 0.30;
    reasons.push("No validated rule found — AI generated thresholds");
  }

  const deduction = Math.min((input.conditionCount - 1) * 0.10, 0.20);
  score -= deduction;
  if (deduction > 0) {
    reasons.push(`Multiple conditions reduce confidence by ${deduction}`);
  }

  if (input.fhirRecordComplete) {
    score += 0.10;
    reasons.push("FHIR record complete");
  } else {
    score -= 0.15;
    reasons.push("FHIR record incomplete");
  }

  if (input.zodValidationPassed && !input.usedFallback) {
    score += 0.10;
    reasons.push("Zod validation passed with no fallback");
  }

  if (input.usedFallback) {
    score -= 0.20;
    reasons.push("Fallback protocol used — Nova Pro output invalid");
  }

  if (input.laceRiskLevel === "VERY HIGH") {
    score += 0.05;
    reasons.push("LACE VERY HIGH — protocol priority elevated");
  }

  if (input.laceRiskLevel === "LOW") {
    score += 0.05;
    reasons.push("LACE LOW — straightforward protocol");
  }

  const finalScore = Math.max(0, Math.min(1, score));
  const threshold = parseFloat(process.env["CONFIDENCE_THRESHOLD"] ?? "0.7");
  const autoApprove = finalScore >= threshold;

  return { score: finalScore, autoApprove, reasons };
}
