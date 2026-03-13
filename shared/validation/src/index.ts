// ─── Input Validation ─────────────────────────────────────────────────────────
// Zero AWS SDK imports — pure functions only.
// All functions return false on invalid input and never throw.

export function validatePatientId(patientId: unknown): boolean {
  if (typeof patientId !== "string") return false;
  if (patientId.length !== 4) return false;
  return /^P\d{3}$/.test(patientId);
}

export function validateCallId(callId: unknown): boolean {
  if (typeof callId !== "string") return false;
  if (callId.length !== 4) return false;
  return /^C\d{3}$/.test(callId);
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
