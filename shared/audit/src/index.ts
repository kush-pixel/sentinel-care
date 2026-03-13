// ─── PHI Audit Logger ─────────────────────────────────────────────────────────
// Zero AWS SDK imports — pure console logging only.
// In production this would ship to CloudWatch via the Lambda logging layer.
//
// NEVER log: patient names, DOBs, phone numbers, variable values, SBAR content.
// DO log:    patientId, eventType, action, timestamp, success, performedBy.

export interface AuditEvent {
  eventType:
    | "DATA_ACCESS"
    | "TRIAGE_COMPLETE"
    | "SBAR_GENERATED"
    | "NURSE_ACKNOWLEDGE"
    | "ESCALATION_FIRED"
    | "PROTOCOL_GENERATED";
  patientId: string;
  callId?: string;
  performedBy:
    | "SYSTEM"
    | "NURSE"
    | "CARE_PLANNER"
    | "TRIAGE_ENGINE"
    | "SUMMARIZER";
  action: string;
  timestamp: string;
  success: boolean;
  errorCode?: string;
}

export function auditLog(event: AuditEvent): void {
  try {
    console.log(
      `[AUDIT] ${event.timestamp} ${event.eventType} patient=${event.patientId}` +
        ` by=${event.performedBy} action=${event.action} success=${event.success}`
    );
  } catch {
    // Never throw — audit failures must not interrupt clinical workflows
  }
}

export function auditDataAccess(
  patientId: string,
  performedBy: AuditEvent["performedBy"],
  action: string
): void {
  auditLog({
    eventType: "DATA_ACCESS",
    patientId,
    performedBy,
    action,
    timestamp: new Date().toISOString(),
    success: true,
  });
}

export function auditEscalation(
  patientId: string,
  callId: string,
  success: boolean
): void {
  auditLog({
    eventType: "ESCALATION_FIRED",
    patientId,
    callId,
    performedBy: "TRIAGE_ENGINE",
    action: "SNS RED alert published",
    timestamp: new Date().toISOString(),
    success,
  });
}
