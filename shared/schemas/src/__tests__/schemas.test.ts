import {
  TriageProtocol,
  PatientAnswers,
  DashboardPayload,
  ClinicalRuleSchema,
  ProtocolReviewSchema,
  LaceResultSchema,
} from "../index.js";
import { safeParseProtocol } from "../validate.js";

// ─── Test 1: Valid CHF protocol passes validation ─────────────────────────────

test("valid CHF protocol passes TriageProtocol schema", () => {
  const input = {
    patient_id: "P001",
    preferred_language: "en",
    question_priority: ["weight_gain_lbs"],
    flag_color: "RED",
    root_node: {
      logic: "OR",
      conditions: [
        { variable: "weight_gain_lbs", operator: ">=", threshold: 3, weight: 0.8 },
      ],
    },
  };

  const result = TriageProtocol.safeParse(input);
  expect(result.success).toBe(true);
});

// ─── Test 2: Invalid operator fails and returns fallback ──────────────────────

test("protocol with invalid operator returns success:false and valid fallback", () => {
  const input = {
    patient_id: "P001",
    preferred_language: "en",
    question_priority: [],
    flag_color: "RED",
    root_node: {
      logic: "OR",
      conditions: [{ variable: "test", operator: "INVALID", threshold: 1 }],
    },
  };

  const result = safeParseProtocol(input);
  expect(result.success).toBe(false);

  if (!result.success) {
    expect(result.fallback.flag_color).toBe("YELLOW");
    expect(TriageProtocol.safeParse(result.fallback).success).toBe(true);
  }
});

// ─── Test 3: Malformed JSON string returns fallback without crashing ──────────

test("malformed JSON string returns success:false and does not throw", () => {
  const result = safeParseProtocol("{ this is not valid json }");
  expect(result.success).toBe(false);
});

// ─── Test 4: PatientAnswers with INCOMPLETE status validates correctly ─────────

test("PatientAnswers with INCOMPLETE status validates correctly", () => {
  const input = {
    call_id: "C001",
    patient_id: "P001",
    variables: {},
    unresolved_variables: [],
    transcript_warnings: [],
    call_status: "INCOMPLETE",
  };

  const result = PatientAnswers.safeParse(input);
  expect(result.success).toBe(true);
});

// ─── Test 5: DashboardPayload with null acknowledged_by validates correctly ───

test("DashboardPayload with null acknowledged_by validates correctly", () => {
  const input = {
    patient_id: "P001",
    call_id: "C001",
    triage_status: "GREEN",
    broken_rules: [],
    sbar_summary: "Patient is stable.",
    transcript_warnings: [],
    nurse_acknowledged: false,
    acknowledged_by: null,
    acknowledged_at: null,
    call_status: "COMPLETE",
    escalation_triggered: false,
  };

  const result = DashboardPayload.safeParse(input);
  expect(result.success).toBe(true);
});

// ─── Test 6: ClinicalRuleSchema valid ────────────────────────────────────────

test("ClinicalRuleSchema accepts a valid clinical rule", () => {
  const input = {
    condition_code: "I50.9",
    condition_display: "Heart failure, unspecified",
    guideline_source: "ACC/AHA 2022",
    guideline_url: "https://example.com/guideline",
    last_reviewed: "2024-01-15",
    reviewed_by: "Dr. Smith",
    flag_color: "RED",
    readmission_risk_level: "HIGH",
    question_priority: ["weight_gain_lbs", "dyspnea", "edema"],
    conditions: [
      {
        variable: "weight_gain_lbs",
        operator: ">=",
        threshold: 3,
        weight: 0.9,
        flag_color: "RED",
        clinical_note: "Weight gain >3 lbs in 24h indicates fluid retention",
        source: "ACC/AHA 2022 Heart Failure Guidelines",
      },
    ],
    logic: "OR",
    weighted_threshold: 0.75,
  };

  const result = ClinicalRuleSchema.safeParse(input);
  expect(result.success).toBe(true);
});

// ─── Test 7: ClinicalRuleSchema rejects invalid operator ─────────────────────

test("ClinicalRuleSchema rejects condition with invalid operator", () => {
  const input = {
    condition_code: "I50.9",
    condition_display: "Heart failure, unspecified",
    guideline_source: "ACC/AHA 2022",
    guideline_url: "https://example.com/guideline",
    last_reviewed: "2024-01-15",
    reviewed_by: "Dr. Smith",
    flag_color: "RED",
    readmission_risk_level: "HIGH",
    question_priority: ["weight_gain_lbs"],
    conditions: [
      {
        variable: "weight_gain_lbs",
        operator: "!=",
        threshold: 3,
        weight: 0.9,
        flag_color: "RED",
        clinical_note: "Invalid operator test",
        source: "ACC/AHA 2022",
      },
    ],
    logic: "OR",
    weighted_threshold: 0.75,
  };

  const result = ClinicalRuleSchema.safeParse(input);
  expect(result.success).toBe(false);
});

// ─── Test 8: ProtocolReviewSchema valid AUTO_APPROVED ────────────────────────

test("ProtocolReviewSchema accepts a valid AUTO_APPROVED review", () => {
  const input = {
    review_id: "REV-001",
    patient_id: "P001",
    status: "AUTO_APPROVED",
    confidence_score: 0.94,
    auto_approval_reason: null,
    pending_reason: null,
    protocol: {
      patient_id: "P001",
      preferred_language: "en",
      question_priority: ["weight_gain_lbs"],
      flag_color: "RED",
      root_node: {
        logic: "OR",
        conditions: [
          { variable: "weight_gain_lbs", operator: ">=", threshold: 3, weight: 0.9 },
        ],
      },
    },
    protocol_source: "validated_library",
    condition_code: "I50.9",
    ai_model_used: "amazon.nova-lite-v1:0",
    rejection_reason: null,
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
    created_at: "2024-01-15T10:00:00Z",
    approved_at: null,
  };

  const result = ProtocolReviewSchema.safeParse(input);
  expect(result.success).toBe(true);
});

// ─── Test 9: ProtocolReviewSchema rejects invalid status ─────────────────────

test("ProtocolReviewSchema rejects invalid status value", () => {
  const input = {
    review_id: "REV-002",
    patient_id: "P001",
    status: "MAYBE",
    confidence_score: 0.5,
    auto_approval_reason: null,
    pending_reason: null,
    protocol: {
      patient_id: "P001",
      preferred_language: "en",
      question_priority: ["weight_gain_lbs"],
      flag_color: "RED",
      root_node: {
        logic: "OR",
        conditions: [
          { variable: "weight_gain_lbs", operator: ">=", threshold: 3, weight: 0.9 },
        ],
      },
    },
    protocol_source: "ai_generated",
    condition_code: "I50.9",
    ai_model_used: "amazon.nova-lite-v1:0",
    rejection_reason: null,
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
    created_at: "2024-01-15T10:00:00Z",
    approved_at: null,
  };

  const result = ProtocolReviewSchema.safeParse(input);
  expect(result.success).toBe(false);
});

// ─── Test 10: LaceResultSchema valid HIGH ─────────────────────────────────────

test("LaceResultSchema accepts a valid HIGH result", () => {
  const input = {
    totalScore: 10,
    riskLevel: "HIGH",
    components: { L: 4, A: 3, C: 1, E: 2 },
    lengthOfStayDays: 6,
    charlsonScore: 1,
    interpretation: "LACE score 10: HIGH readmission risk.",
  };
  const result = LaceResultSchema.safeParse(input);
  expect(result.success).toBe(true);
});

// ─── Test 11: LaceResultSchema rejects score above 19 ────────────────────────

test("LaceResultSchema rejects totalScore above 19", () => {
  const input = {
    totalScore: 20,
    riskLevel: "VERY HIGH",
    components: { L: 7, A: 3, C: 5, E: 4 },
    lengthOfStayDays: 14,
    charlsonScore: 5,
    interpretation: "test",
  };
  const result = LaceResultSchema.safeParse(input);
  expect(result.success).toBe(false);
});
