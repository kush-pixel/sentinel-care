export interface PatientRecord {
  callId: string;
  patientId: string;
  patientName?: string;
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
  ruleVersionId: string | null;
  ruleVersion: number | null;
  ruleEffectiveFrom: string | null;
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

export interface ProtocolCondition {
  variable: string;
  operator: string;
  threshold: number | boolean;
  weight: number;
  flag_color?: string;
}

export interface ProtocolReviewRecord {
  reviewId: string;
  patientId: string;
  status: "PENDING_REVIEW" | "AUTO_APPROVED" | "APPROVED" | "REJECTED";
  confidenceScore: number;
  pendingReason: string | null;
  autoApprovalReason: string | null;
  protocolSource: string;
  conditionCode: string;
  laceScore: number;
  laceRiskLevel: string;
  laceComponents: { L: number; A: number; C: number; E: number } | null;
  aiModelUsed: string | null;
  rejectionReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  createdAt: string;
  approvedAt: string | null;
  ruleVersionId?: string | null;
  ruleVersion?: number | null;
  ruleEffectiveFrom?: string | null;
  isRegeneration?: boolean;
  previousReviewId?: string | null;
  regenerationReason?: string | null;
  regenerationCount?: number;
  regeneratedAs?: string | null;
  regenerationTriggeredAt?: string | null;
  protocol: {
    patient_id: string;
    preferred_language: string;
    flag_color: string;
    question_priority: string[];
    root_node: {
      logic: "AND" | "OR";
      conditions: ProtocolCondition[];
      weighted_threshold: number;
    };
  } | null;
}

export interface ReviewStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  autoApproved: number;
}
