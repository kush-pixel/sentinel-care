// ─── Rule versioning utilities ────────────────────────────────────────────────
export * from "./rule-versioning";

// ─── Input Validation ─────────────────────────────────────────────────────────
// Pure functions only — no AWS SDK imports in this section.

import { randomUUID } from "crypto";

// SQL injection patterns: semicolons, quotes, double-dash comments, block-comment opens
const SQL_INJECTION_RE = /[;'"]|--|\/\*/;

// UUID v4 pattern
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// General alphanumeric-with-hyphens: 3–64 chars, starts and ends with alphanumeric
const GENERAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9\-]{1,62}[A-Za-z0-9]$/;

const LEGACY_PATIENT_RE = /^P\d{3}$/;
const LEGACY_CALL_RE    = /^C\d{3}$/;

function isValidIdString(id: string): boolean {
  if (id.length < 3 || id.length > 64) return false;
  if (/\s/.test(id)) return false;
  if (SQL_INJECTION_RE.test(id)) return false;
  return true;
}

export function validatePatientId(patientId: unknown): boolean {
  if (typeof patientId !== "string") return false;
  if (!isValidIdString(patientId)) return false;
  return (
    LEGACY_PATIENT_RE.test(patientId) ||
    UUID_V4_RE.test(patientId) ||
    GENERAL_ID_RE.test(patientId)
  );
}

export function validateCallId(callId: unknown): boolean {
  if (typeof callId !== "string") return false;
  if (!isValidIdString(callId)) return false;
  return (
    LEGACY_CALL_RE.test(callId) ||
    UUID_V4_RE.test(callId) ||
    GENERAL_ID_RE.test(callId)
  );
}

export function generatePatientId(): string {
  return randomUUID();
}

export function generateCallId(): string {
  return "CALL-" + Date.now().toString(16);
}

export function isLegacyId(id: string): boolean {
  return /^[PC]\d{3}$/.test(id);
}

export function validateConfidence(confidence: unknown): boolean {
  if (typeof confidence !== "number") return false;
  return confidence >= 0.0 && confidence <= 1.0;
}

export function sanitiseError(error: unknown): string {
  // Strip any path-like substrings (containing / or \) to avoid leaking
  // internal file paths, table names, or stack frame locations.
  const stripPaths = (str: string): string =>
    str.replace(/\S*[/\\]\S*/g, "[path]").trim();

  if (error instanceof Error) {
    return stripPaths(error.message);
  }
  if (typeof error === "string") {
    return stripPaths(error);
  }
  return "An internal error occurred";
}
