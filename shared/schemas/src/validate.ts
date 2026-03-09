import { TriageProtocol } from "./index.js";
import { buildFallbackProtocol } from "./fallback.js";

type SafeParseSuccess = { success: true; data: TriageProtocol };
type SafeParseFailure = { success: false; error: string; fallback: TriageProtocol };

/**
 * Safely parses an unknown value as a TriageProtocol.
 * - Accepts raw objects or JSON strings.
 * - NEVER throws — always returns a usable result.
 * - On failure, the returned `fallback` is a pre-validated safe default.
 */
export function safeParseProtocol(raw: unknown): SafeParseSuccess | SafeParseFailure {
  const fallback = buildFallbackProtocol("fallback");

  let candidate: unknown = raw;

  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw) as unknown;
    } catch {
      return { success: false, error: "Invalid JSON string", fallback };
    }
  }

  const result = TriageProtocol.safeParse(candidate);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    error: result.error.message,
    fallback,
  };
}
