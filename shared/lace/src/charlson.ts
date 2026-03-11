// Charlson Comorbidity Index mapped to ICD-10 codes
export const CHARLSON_ICD10_WEIGHTS: Record<string, number> = {
  "I21.9": 1,
  "I22":   1,
  "I50.9": 1,
  "I50.1": 1,
  "I27.9": 1,
  "I64":   1,
  "G30":   1,
  "G31.1": 1,
  "J44.0": 1,
  "J44.1": 1,
  "J45":   1,
  "M05":   1,
  "M06":   1,
  "I12.9": 1,
  "N18.1": 1,
  "N18.2": 1,
  "E11.9": 1,
  "E11.6": 2,
  "E10.9": 1,
  "N18.3": 2,
  "N18.4": 2,
  "N18.5": 2,
  "G81":   2,
  "G82":   2,
  "C80":   2,
  "C78":   6,
  "C91":   2,
  "C81":   2,
  "B20":   6,
};

export function calculateCharlsonScore(conditionCodes: string[]): number {
  return conditionCodes.reduce((sum, code) => sum + (CHARLSON_ICD10_WEIGHTS[code] ?? 0), 0);
}

export function charlsonToLacePoints(charlsonScore: number): number {
  if (charlsonScore <= 0) return 0;
  if (charlsonScore >= 5) return 5;
  return charlsonScore;
}

export function getConditionCharlsonWeight(code: string): number {
  return CHARLSON_ICD10_WEIGHTS[code] ?? 0;
}
