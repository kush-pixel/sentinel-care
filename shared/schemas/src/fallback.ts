import { type TriageProtocol } from "./index.js";

/**
 * Returns a safe, pre-validated TriageProtocol used when Agent 1 fails
 * Zod validation. The fallback uses a conservative OR-logic yellow flag
 * that covers the most common symptom and adherence variables.
 */
export function buildFallbackProtocol(patient_id: string): TriageProtocol {
  return {
    patient_id,
    preferred_language: "en",
    question_priority: ["general_symptoms", "medication_adherence"],
    flag_color: "YELLOW",
    root_node: {
      logic: "OR",
      conditions: [
        { variable: "general_symptoms", operator: "==", threshold: true },
        { variable: "medication_adherence", operator: "==", threshold: false },
      ],
    },
  };
}
