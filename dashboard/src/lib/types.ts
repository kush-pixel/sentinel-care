export interface PatientRecord {
  callId: string;
  patientId: string;
  triageStatus: "RED" | "YELLOW" | "GREEN" | "INCOMPLETE";
  brokenRules: string[];
  weightedScore: number;
  laceScore: number;
  laceRiskLevel: string;
  laceComponents?: {
    L: number;
    A: number;
    C: number;
    E: number;
  };
  sbarSummary: string;
  nurseAcknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  conditionCode: string;
  guidelineSource: string;
  callTimestamp: string;
  triageCompletedAt: string | null;
  protocolSource: string | null;
}

export interface DashboardStats {
  total: number;
  red: number;
  yellow: number;
  green: number;
  incomplete: number;
  acknowledged: number;
  pending: number;
}
