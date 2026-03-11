import { scoreConfidence, type ConfidenceInput } from "../confidence";

// Test 1 — High confidence
// 0.50 +0.30(rules) +0.10(fhir) +0.10(zod) = 1.00 (clamped)
test("High confidence: all positive flags", () => {
  const input: ConfidenceInput = {
    conditionCode: "I50.9",
    rulesFound: true,
    conditionCount: 1,
    fhirRecordComplete: true,
    zodValidationPassed: true,
    usedFallback: false,
  };
  const result = scoreConfidence(input);
  expect(result.score).toBeGreaterThanOrEqual(0.85);
  expect(result.autoApprove).toBe(true);
});

// Test 2 — Low confidence
// 0.50 -0.30(no rules) -0.20(comorbidities) -0.15(no fhir) -0.20(fallback) = -0.35 → 0
test("Low confidence: all negative flags", () => {
  const input: ConfidenceInput = {
    conditionCode: "UNKNOWN",
    rulesFound: false,
    conditionCount: 3,
    fhirRecordComplete: false,
    zodValidationPassed: true,
    usedFallback: true,
  };
  const result = scoreConfidence(input);
  expect(result.score).toBeLessThan(0.5);
  expect(result.autoApprove).toBe(false);
});

// Test 3 — Borderline
// 0.50 +0.30(rules) -0.10(conditionCount 2) +0.10(fhir) +0.10(zod) = 0.90
test("Borderline: one comorbidity reduces score", () => {
  const input: ConfidenceInput = {
    conditionCode: "E11.9",
    rulesFound: true,
    conditionCount: 2,
    fhirRecordComplete: true,
    zodValidationPassed: true,
    usedFallback: false,
  };
  const result = scoreConfidence(input);
  expect(result.score).toBeGreaterThanOrEqual(0.60);
  expect(result.score).toBeLessThan(1.0);
  expect(result.autoApprove).toBe(true);
});

// Test 4 — Fallback drops score
// 0.50 +0.30(rules) +0.10(fhir) -0.20(fallback) = 0.70
test("Fallback drops score below 0.80", () => {
  const input: ConfidenceInput = {
    conditionCode: "I50.9",
    rulesFound: true,
    conditionCount: 1,
    fhirRecordComplete: true,
    zodValidationPassed: false,
    usedFallback: true,
  };
  const result = scoreConfidence(input);
  expect(result.score).toBeLessThan(0.80);
});

// Test 5 — Reasons never empty
test("Reasons array is never empty", () => {
  const input: ConfidenceInput = {
    conditionCode: "J18.9",
    rulesFound: true,
    conditionCount: 1,
    fhirRecordComplete: true,
    zodValidationPassed: true,
    usedFallback: false,
  };
  const result = scoreConfidence(input);
  expect(result.reasons.length).toBeGreaterThanOrEqual(1);
});

// Test 6 — LACE LOW gives bonus
// 0.50 +0.30(rules) +0.10(fhir) +0.10(zod) +0.05(LACE LOW) = 1.05 → 1.00
test("LACE LOW gives bonus and score exceeds 0.90", () => {
  const input: ConfidenceInput = {
    conditionCode: "Z96.651",
    rulesFound: true,
    conditionCount: 1,
    fhirRecordComplete: true,
    zodValidationPassed: true,
    usedFallback: false,
    laceScore: 2,
    laceRiskLevel: "LOW",
  };
  const result = scoreConfidence(input);
  expect(result.score).toBeGreaterThan(0.90);
  expect(result.autoApprove).toBe(true);
});
