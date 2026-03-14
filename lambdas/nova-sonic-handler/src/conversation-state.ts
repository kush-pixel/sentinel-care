/**
 * conversation-state.ts — Tracks the full state of a Nova Sonic patient call.
 *
 * Responsibilities:
 *  - Loads all questions from a TriageProtocol
 *  - Formats each question using question-formatter
 *  - Maintains answer state, off-topic tracking, clarification counts
 *  - Provides pure-function helpers that return updated states (no mutation)
 */

import { formatQuestion, getFollowUpQuestion } from "./question-formatter";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QuestionItem {
  variable: string;
  operator: string;
  threshold: number | boolean | string;
  weight: number;
  flag_color: string;
  question: string;
  followUp: string;
  asked: boolean;
  answered: boolean;
  attempts: number;
}

export interface ExtractedAnswer {
  variable: string;
  value: boolean | number | string | null;
  confidence: number;
  rawResponse: string;
  needsFollowUp: boolean;
  wasAmbiguous: boolean;
}

export interface ConversationState {
  patientId: string;
  callId: string;
  patientName: string;
  language: string;
  questions: QuestionItem[];
  currentQuestionIndex: number;
  answers: Map<string, ExtractedAnswer>;
  offTopicCount: number;
  clarificationCount: number;
  urgentEscalation: boolean;
  callStartTime: Date;
  callEndReason:
    | "completed"
    | "patient_request"
    | "no_response"
    | "urgent_escalation"
    | "error"
    | null;
}

// ─── Protocol node type (minimal, works for any condition set) ─────────────────

interface ProtocolCondition {
  variable: string;
  operator: string;
  threshold: number | boolean | string;
  weight?: number;
  flag_color?: string;
}

interface ProtocolNode {
  conditions: ProtocolCondition[];
  sub_nodes?: ProtocolNode[];
}

interface TriageProtocolShape {
  root_node?: ProtocolNode;
  condition_code?: string;
  condition_display?: string;
  guideline_source?: string;
}

// ─── FHIR patient record minimal shape ────────────────────────────────────────

interface FhirName {
  family?: string;
  given?: string[];
  text?: string;
}

interface FhirPatient {
  name?: FhirName[];
  communication?: {
    language?: {
      coding?: { code?: string }[];
    };
  }[];
}

interface FhirConditionEntry {
  code?: {
    text?: string;
    coding?: { code?: string; display?: string }[];
  };
}

interface FhirMedEntry {
  medication?: {
    text?: string;
    concept?: { text?: string };
  };
  medicationCodeableConcept?: { text?: string };
}

export interface FhirPatientRecord {
  patient?: FhirPatient;
  conditions?: FhirConditionEntry[];
  medications?: FhirMedEntry[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractPatientName(patient: FhirPatient | undefined): string {
  if (!patient?.name || patient.name.length === 0) return "there";
  const n = patient.name[0];
  if (n.text) return n.text;
  const given  = n.given?.join(" ") ?? "";
  const family = n.family ?? "";
  return `${given} ${family}`.trim() || "there";
}

function extractLanguage(patient: FhirPatient | undefined): string {
  return (
    patient?.communication?.[0]?.language?.coding?.[0]?.code ?? "en"
  );
}

function extractMedications(medications: FhirMedEntry[] | undefined): string[] {
  if (!medications) return [];
  return medications.flatMap((m) => {
    const text =
      m.medication?.text ??
      m.medication?.concept?.text ??
      m.medicationCodeableConcept?.text ??
      null;
    return text ? [text] : [];
  });
}

/** Collect all conditions recursively from the protocol root node. */
function collectAllConditions(node: ProtocolNode): ProtocolCondition[] {
  const out: ProtocolCondition[] = [...node.conditions];
  for (const sub of node.sub_nodes ?? []) {
    out.push(...collectAllConditions(sub));
  }
  return out;
}

// ─── buildConversationState ───────────────────────────────────────────────────

export function buildConversationState(
  patientId: string,
  callId: string,
  protocol: unknown,
  patientRecord: FhirPatientRecord
): ConversationState {
  const proto = protocol as TriageProtocolShape;
  const conditionCode    = proto.condition_code    ?? "UNKNOWN";
  const conditionDisplay = proto.condition_display ?? "Unknown condition";

  const patientName = extractPatientName(patientRecord.patient);
  const language    = extractLanguage(patientRecord.patient);
  const medications = extractMedications(patientRecord.medications);

  // Collect and deduplicate conditions by variable
  const rawConditions = proto.root_node
    ? collectAllConditions(proto.root_node)
    : [];

  const seenVars = new Set<string>();
  const uniqueConditions = rawConditions.filter((c) => {
    if (seenVars.has(c.variable)) return false;
    seenVars.add(c.variable);
    return true;
  });

  // Build QuestionItems, sorted by weight descending (most critical first)
  const questions: QuestionItem[] = uniqueConditions
    .map((cond): QuestionItem => {
      const ctx = {
        variable:         cond.variable,
        operator:         cond.operator,
        threshold:        cond.threshold,
        conditionCode,
        conditionDisplay,
        language,
        patientName,
        medications,
      };
      return {
        variable:   cond.variable,
        operator:   cond.operator,
        threshold:  cond.threshold,
        weight:     typeof cond.weight === "number" ? cond.weight : 1,
        flag_color: typeof cond.flag_color === "string" ? cond.flag_color : "YELLOW",
        question:   formatQuestion(ctx),
        followUp:   getFollowUpQuestion(cond.variable, "", language),
        asked:      false,
        answered:   false,
        attempts:   0,
      };
    })
    .sort((a, b) => b.weight - a.weight);

  return {
    patientId,
    callId,
    patientName,
    language,
    questions,
    currentQuestionIndex: 0,
    answers:              new Map<string, ExtractedAnswer>(),
    offTopicCount:        0,
    clarificationCount:   0,
    urgentEscalation:     false,
    callStartTime:        new Date(),
    callEndReason:        null,
  };
}

// ─── getNextQuestion ──────────────────────────────────────────────────────────

export function getNextQuestion(state: ConversationState): QuestionItem | null {
  return state.questions.find((q) => !q.answered) ?? null;
}

// ─── markAnswered ─────────────────────────────────────────────────────────────

export function markAnswered(
  state: ConversationState,
  variable: string,
  answer: ExtractedAnswer
): ConversationState {
  const questions = state.questions.map((q) =>
    q.variable === variable ? { ...q, answered: true, asked: true } : q
  );
  const answers = new Map(state.answers);
  answers.set(variable, answer);

  const nextUnanswered = questions.findIndex((q) => !q.answered);
  return {
    ...state,
    questions,
    answers,
    currentQuestionIndex:
      nextUnanswered === -1 ? questions.length : nextUnanswered,
    offTopicCount:        0, // reset per-answer off-topic counter
    clarificationCount:   0,
  };
}

// ─── markAsked ────────────────────────────────────────────────────────────────

export function markAsked(
  state: ConversationState,
  variable: string
): ConversationState {
  const questions = state.questions.map((q) =>
    q.variable === variable
      ? { ...q, asked: true, attempts: q.attempts + 1 }
      : q
  );
  return { ...state, questions };
}

// ─── shouldRedirect ───────────────────────────────────────────────────────────

export function shouldRedirect(state: ConversationState): boolean {
  return state.offTopicCount >= 2;
}

// ─── incrementOffTopic ────────────────────────────────────────────────────────

export function incrementOffTopic(state: ConversationState): ConversationState {
  return { ...state, offTopicCount: state.offTopicCount + 1 };
}

// ─── incrementClarification ───────────────────────────────────────────────────

export function incrementClarification(
  state: ConversationState
): ConversationState {
  return { ...state, clarificationCount: state.clarificationCount + 1 };
}

// ─── setCallEndReason ─────────────────────────────────────────────────────────

export function setCallEndReason(
  state: ConversationState,
  reason: ConversationState["callEndReason"]
): ConversationState {
  return { ...state, callEndReason: reason };
}

// ─── setUrgentEscalation ──────────────────────────────────────────────────────

export function setUrgentEscalation(
  state: ConversationState
): ConversationState {
  return {
    ...state,
    urgentEscalation: true,
    callEndReason:    "urgent_escalation",
  };
}

// ─── deriveCallStatus ─────────────────────────────────────────────────────────

export function deriveCallStatus(state: ConversationState): "COMPLETE" | "PARTIAL" {
  const total    = state.questions.length;
  const answered = state.answers.size;
  if (total === 0) return "COMPLETE";
  return answered / total >= 0.5 ? "COMPLETE" : "PARTIAL";
}
