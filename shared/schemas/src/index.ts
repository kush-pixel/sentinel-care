import { z } from "zod";

// ─── ConditionNode ────────────────────────────────────────────────────────────

const ConditionNodeSchema = z.object({
  variable: z.string(),
  operator: z.enum([">=", "<=", "==", ">", "<"]),
  threshold: z.union([z.number(), z.boolean(), z.string()]),
  weight: z.number().min(0).max(1).optional(),
});

export type ConditionNode = z.infer<typeof ConditionNodeSchema>;

// ─── RuleNode (recursive via z.lazy) ─────────────────────────────────────────
// RuleNodeSchemaInner provides the concrete shape; z.lazy wraps it so that
// forward-references compile cleanly and the recursive pattern is explicit.

const RuleNodeSchemaInner = z.object({
  logic: z.enum(["AND", "OR"]),
  conditions: z.array(ConditionNodeSchema),
  weighted_threshold: z.number().optional(),
});

type RuleNodeShape = z.infer<typeof RuleNodeSchemaInner>;

export const RuleNodeSchema: z.ZodType<RuleNodeShape> = z.lazy(
  () => RuleNodeSchemaInner
);

export type RuleNode = RuleNodeShape;

// ─── TriageProtocol ───────────────────────────────────────────────────────────

export const TriageProtocol = z.object({
  patient_id: z.string(),
  preferred_language: z.string().default("en"),
  question_priority: z.array(z.string()),
  flag_color: z.enum(["GREEN", "YELLOW", "RED"]),
  root_node: RuleNodeSchema,
});

export type TriageProtocol = z.infer<typeof TriageProtocol>;

// ─── ExtractedVariable ────────────────────────────────────────────────────────

const ExtractedVariableSchema = z.object({
  value: z.union([z.number(), z.boolean(), z.string()]),
  confidence: z.number().min(0).max(1),
});

export type ExtractedVariable = z.infer<typeof ExtractedVariableSchema>;

// ─── PatientAnswers ───────────────────────────────────────────────────────────

export const PatientAnswers = z.object({
  call_id: z.string(),
  patient_id: z.string(),
  variables: z.record(ExtractedVariableSchema),
  unresolved_variables: z.array(z.string()),
  transcript_warnings: z.array(
    z.object({ section: z.string(), warning: z.string() })
  ),
  call_status: z.enum(["COMPLETE", "INCOMPLETE"]),
});

export type PatientAnswers = z.infer<typeof PatientAnswers>;

// ─── LaceComponents ───────────────────────────────────────────────────────────

export const LaceComponentsSchema = z.object({
  L: z.number().min(0).max(7),
  A: z.number().min(0).max(3),
  C: z.number().min(0).max(5),
  E: z.number().min(0).max(4),
});

export type LaceComponents = z.infer<typeof LaceComponentsSchema>;

// ─── LaceResult ───────────────────────────────────────────────────────────────

export const LaceResultSchema = z.object({
  totalScore: z.number().min(0).max(19),
  riskLevel: z.enum(["LOW", "MODERATE", "HIGH", "VERY HIGH"]),
  components: LaceComponentsSchema,
  lengthOfStayDays: z.number().min(0),
  charlsonScore: z.number().min(0),
  interpretation: z.string(),
});

export type LaceResult = z.infer<typeof LaceResultSchema>;

// ─── DashboardPayload ─────────────────────────────────────────────────────────

export const DashboardPayload = z.object({
  patient_id: z.string(),
  call_id: z.string(),
  triage_status: z.enum(["GREEN", "YELLOW", "RED", "INCOMPLETE"]),
  broken_rules: z.array(z.string()),
  weighted_score: z.number().optional(),
  sbar_summary: z.string(),
  transcript_warnings: z.array(
    z.object({ section: z.string(), warning: z.string() })
  ),
  nurse_acknowledged: z.boolean().default(false),
  acknowledged_by: z.string().nullable(),
  acknowledged_at: z.string().nullable(),
  call_status: z.enum(["COMPLETE", "INCOMPLETE"]),
  escalation_triggered: z.boolean(),
  condition_code: z.string().optional(),
  protocol_source: z.enum([
    "validated_library",
    "ai_generated",
    "none",
  ]).optional(),
  lace_result: LaceResultSchema.optional(),
});

export type DashboardPayload = z.infer<typeof DashboardPayload>;

// ─── ClinicalRuleCondition ────────────────────────────────────────────────────

export const ClinicalRuleConditionSchema = z.object({
  variable: z.string(),
  operator: z.enum([">=", "<=", "==", ">", "<"]),
  threshold: z.union([z.number(), z.boolean()]),
  weight: z.number().min(0).max(1),
  flag_color: z.enum(["RED", "YELLOW", "GREEN"]),
  clinical_note: z.string(),
  source: z.string(),
});

export type ClinicalRuleCondition = z.infer<typeof ClinicalRuleConditionSchema>;

// ─── ClinicalRule ─────────────────────────────────────────────────────────────

export const ClinicalRuleSchema = z.object({
  condition_code: z.string(),
  condition_display: z.string(),
  guideline_source: z.string(),
  guideline_url: z.string(),
  last_reviewed: z.string(),
  reviewed_by: z.string(),
  flag_color: z.enum(["RED", "YELLOW", "GREEN"]),
  readmission_risk_level: z.enum(["HIGH", "MODERATE", "LOW"]),
  question_priority: z.array(z.string()).min(1),
  conditions: z.array(ClinicalRuleConditionSchema).min(1),
  logic: z.enum(["AND", "OR"]),
  weighted_threshold: z.number().min(0).max(1),
  // ── Versioning fields (optional for backwards compatibility with legacy data) ──
  version: z.number().int().min(1).default(1),
  version_id: z.string().optional(),
  is_latest: z.boolean().default(true),
  effective_from: z.string().optional(),
  superseded_by: z.string().nullable().default(null),
  change_notes: z.string().nullable().default(null),
  created_by: z.string().default("SYSTEM"),
  created_at: z.string().optional(),
});

export type ClinicalRule = z.infer<typeof ClinicalRuleSchema>;

// ─── ProtocolReview ───────────────────────────────────────────────────────────

export const ProtocolReviewSchema = z.object({
  review_id: z.string(),
  patient_id: z.string(),
  status: z.enum([
    "PENDING_REVIEW",
    "AUTO_APPROVED",
    "APPROVED",
    "REJECTED",
  ]),
  confidence_score: z.number().min(0).max(1),
  auto_approval_reason: z.string().nullable(),
  pending_reason: z.string().nullable(),
  protocol: TriageProtocol,
  protocol_source: z.enum(["validated_library", "ai_generated"]),
  condition_code: z.string(),
  ai_model_used: z.string(),
  rejection_reason: z.string().nullable(),
  reviewed_by: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  review_notes: z.string().nullable(),
  created_at: z.string(),
  approved_at: z.string().nullable(),
  lace_result: LaceResultSchema.optional(),
});

export type ProtocolReview = z.infer<typeof ProtocolReviewSchema>;
