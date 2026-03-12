import { extractValue } from "../extractor";

// These tests call the real Nova Lite API via AWS Bedrock.
// Allow up to 60 seconds per test (configured in package.json testTimeout).

describe("extractValue — Nova Lite integration", () => {
  // ─── Test 1: Clear yes response ──────────────────────────────────────────

  it("Test 1 — clear yes → true with high confidence", async () => {
    const result = await extractValue({
      transcript: "yes",
      questionVariable: "medication_adherence",
      expectedType: "yn",
    });
    expect(result.variable).toBe("medication_adherence");
    expect(result.extractedValue).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.fallback).toBe(false);
  });

  // ─── Test 2: Clear no response ───────────────────────────────────────────

  it("Test 2 — clear no → false with high confidence", async () => {
    const result = await extractValue({
      transcript: "no I have not taken it",
      questionVariable: "antibiotic_taken",
      expectedType: "yn",
    });
    expect(result.variable).toBe("antibiotic_taken");
    expect(result.extractedValue).toBe(false);
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.fallback).toBe(false);
  });

  // ─── Test 3: Number from sentence ────────────────────────────────────────

  it("Test 3 — number from sentence → 4", async () => {
    const result = await extractValue({
      transcript: "I gained about four pounds",
      questionVariable: "weight_gain_lbs",
      expectedType: "number",
    });
    expect(result.variable).toBe("weight_gain_lbs");
    expect(result.extractedValue).toBe(4);
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
    expect(result.fallback).toBe(false);
  });

  // ─── Test 4: Temperature extraction ─────────────────────────────────────

  it("Test 4 — temperature in words → 101.5", async () => {
    const result = await extractValue({
      transcript: "my temperature was one hundred and one point five",
      questionVariable: "fever",
      expectedType: "number",
    });
    expect(result.variable).toBe("fever");
    expect(result.extractedValue).toBe(101.5);
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
    expect(result.fallback).toBe(false);
  });

  // ─── Test 5: Pain scale number ───────────────────────────────────────────

  it("Test 5 — pain scale 'seven out of ten' → 7", async () => {
    const result = await extractValue({
      transcript: "seven out of ten",
      questionVariable: "pain_level",
      expectedType: "number",
    });
    expect(result.variable).toBe("pain_level");
    expect(result.extractedValue).toBe(7);
    expect(result.confidence).toBeGreaterThanOrEqual(0.80);
    expect(result.fallback).toBe(false);
  });

  // ─── Test 6: Unclear response returns null ───────────────────────────────

  it("Test 6 — unclear response → null with low confidence", async () => {
    const result = await extractValue({
      transcript: "umm I don't know maybe I think so",
      questionVariable: "weight_gain_lbs",
      expectedType: "number",
    });
    expect(result.variable).toBe("weight_gain_lbs");
    expect(result.extractedValue).toBeNull();
    expect(result.confidence).toBeLessThanOrEqual(0.60);
    expect(result.fallback).toBe(false);
  });

  // ─── Test 7: Spanish yes response ────────────────────────────────────────

  it("Test 7 — Spanish yes 'si' → true", async () => {
    const result = await extractValue({
      transcript: "si",
      questionVariable: "medication_adherence",
      expectedType: "yn",
    });
    expect(result.variable).toBe("medication_adherence");
    expect(result.extractedValue).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.80);
    expect(result.fallback).toBe(false);
  });

  // ─── Test 8: Negative phrasing ───────────────────────────────────────────

  it("Test 8 — negative phrasing 'no chest pain at all' → false", async () => {
    const result = await extractValue({
      transcript: "no chest pain at all",
      questionVariable: "chest_pain",
      expectedType: "yn",
    });
    expect(result.variable).toBe("chest_pain");
    expect(result.extractedValue).toBe(false);
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.fallback).toBe(false);
  });
});
