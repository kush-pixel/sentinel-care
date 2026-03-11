import {
  calculateCharlsonScore,
  charlsonToLacePoints,
} from "./charlson";

export interface LaceInput {
  admissionDate: string;
  dischargeDate: string;
  admissionType: "EMERGENCY" | "PLANNED";
  conditionCodes: string[];
  recentEDVisits: number;
}

export interface LaceComponents {
  L: number;
  A: number;
  C: number;
  E: number;
}

export interface LaceResult {
  totalScore: number;
  riskLevel: "LOW" | "MODERATE" | "HIGH" | "VERY HIGH";
  components: LaceComponents;
  lengthOfStayDays: number;
  charlsonScore: number;
  interpretation: string;
}

export function calculateLengthOfStayPoints(
  admissionDate: string,
  dischargeDate: string
): number {
  const admission = new Date(admissionDate);
  const discharge = new Date(dischargeDate);
  const msPerDay = 1000 * 60 * 60 * 24;
  const days = Math.round((discharge.getTime() - admission.getTime()) / msPerDay);

  if (days <= 0) return 0;
  if (days === 1) return 1;
  if (days === 2) return 2;
  if (days === 3) return 3;
  if (days <= 6) return 4;
  if (days <= 13) return 5;
  return 7; // 14+ days
}

export function calculateAcuityPoints(
  admissionType: "EMERGENCY" | "PLANNED"
): number {
  return admissionType === "EMERGENCY" ? 3 : 0;
}

export function calculateEDVisitPoints(recentEDVisits: number): number {
  if (recentEDVisits <= 0) return 0;
  if (recentEDVisits >= 4) return 4;
  return recentEDVisits;
}

export function scoreToRiskLevel(
  totalScore: number
): "LOW" | "MODERATE" | "HIGH" | "VERY HIGH" {
  if (totalScore <= 4) return "LOW";
  if (totalScore <= 9) return "MODERATE";
  if (totalScore <= 12) return "HIGH";
  return "VERY HIGH";
}

export function calculateLaceScore(input: LaceInput): LaceResult {
  const { admissionDate, dischargeDate, admissionType, conditionCodes, recentEDVisits } = input;

  const L = calculateLengthOfStayPoints(admissionDate, dischargeDate);
  const A = calculateAcuityPoints(admissionType);
  const charlsonScore = calculateCharlsonScore(conditionCodes);
  const C = charlsonToLacePoints(charlsonScore);
  const E = calculateEDVisitPoints(recentEDVisits);

  const totalScore = L + A + C + E;
  const riskLevel = scoreToRiskLevel(totalScore);

  const admission = new Date(admissionDate);
  const discharge = new Date(dischargeDate);
  const msPerDay = 1000 * 60 * 60 * 24;
  const days = Math.max(0, Math.round((discharge.getTime() - admission.getTime()) / msPerDay));

  const interpretation =
    `LACE score ${totalScore}: ${riskLevel} readmission risk. ` +
    `Length of stay ${days} days (${L}pts), ` +
    `${admissionType} admission (${A}pts), ` +
    `Charlson comorbidity score ${charlsonScore} (${C}pts), ` +
    `${recentEDVisits} recent ED visits (${E}pts).`;

  return {
    totalScore,
    riskLevel,
    components: { L, A, C, E },
    lengthOfStayDays: days,
    charlsonScore,
    interpretation,
  };
}
