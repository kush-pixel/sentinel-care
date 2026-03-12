import { NextResponse } from "next/server";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/dynamo";
import type { PatientRecord, DashboardStats } from "@/lib/types";

// ─── Urgency sort priority ────────────────────────────────────────────────────

function urgencyPriority(p: PatientRecord): number {
  if (p.triageStatus === "RED" && !p.nurseAcknowledged) return 0;
  if (p.triageStatus === "YELLOW" && !p.nurseAcknowledged) return 1;
  if (p.triageStatus === "RED" && p.nurseAcknowledged) return 2;
  if (p.triageStatus === "GREEN") return 3;
  if (p.triageStatus === "INCOMPLETE") return 4;
  return 5; // YELLOW acknowledged
}

// ─── DynamoDB item → PatientRecord ───────────────────────────────────────────

function mapItem(item: Record<string, unknown>): PatientRecord {
  // Document client returns unmarshalled values; handle both shapes defensively
  const rawBrokenRules = item.broken_rules;
  let brokenRules: string[] = [];
  if (Array.isArray(rawBrokenRules)) {
    brokenRules = rawBrokenRules.map((r) =>
      typeof r === "object" && r !== null && "S" in r
        ? String((r as { S: string }).S)
        : String(r)
    );
  }

  const laceResult = item.lace_result as
    | { components?: { L?: number; A?: number; C?: number; E?: number } }
    | undefined;

  const laceComponents = laceResult?.components
    ? {
        L: laceResult.components.L ?? 0,
        A: laceResult.components.A ?? 0,
        C: laceResult.components.C ?? 0,
        E: laceResult.components.E ?? 0,
      }
    : undefined;

  const rawScore =
    item.weighted_score !== undefined ? item.weighted_score : 0;
  const parsedScore =
    typeof rawScore === "object" && rawScore !== null && "N" in rawScore
      ? parseFloat(String((rawScore as { N: string }).N))
      : parseFloat(String(rawScore));

  const rawLaceScore = item.lace_score !== undefined ? item.lace_score : 0;
  const parsedLaceScore =
    typeof rawLaceScore === "object" &&
    rawLaceScore !== null &&
    "N" in rawLaceScore
      ? parseInt(String((rawLaceScore as { N: string }).N))
      : parseInt(String(rawLaceScore));

  function str(field: unknown, fallback = ""): string {
    if (typeof field === "string") return field;
    if (
      typeof field === "object" &&
      field !== null &&
      "S" in field
    )
      return String((field as { S: string }).S);
    return fallback;
  }

  function bool(field: unknown): boolean {
    if (typeof field === "boolean") return field;
    if (
      typeof field === "object" &&
      field !== null &&
      "BOOL" in field
    )
      return Boolean((field as { BOOL: boolean }).BOOL);
    return false;
  }

  const rawStatus = str(item.triage_status, "INCOMPLETE");
  const validStatuses = ["RED", "YELLOW", "GREEN", "INCOMPLETE"] as const;
  const triageStatus = validStatuses.includes(
    rawStatus as (typeof validStatuses)[number]
  )
    ? (rawStatus as PatientRecord["triageStatus"])
    : "INCOMPLETE";

  return {
    callId: str(item.call_id),
    patientId: str(item.patient_id),
    triageStatus,
    brokenRules,
    weightedScore: Math.min(isNaN(parsedScore) ? 0 : parsedScore, 1.0),
    laceScore: isNaN(parsedLaceScore) ? 0 : parsedLaceScore,
    laceRiskLevel: str(item.lace_risk_level, "UNKNOWN"),
    laceComponents,
    sbarSummary: str(item.sbar_summary),
    nurseAcknowledged: bool(item.nurse_acknowledged),
    acknowledgedBy: str(item.acknowledged_by) || null,
    acknowledgedAt: str(item.acknowledged_at) || null,
    conditionCode: str(item.condition_code),
    guidelineSource: str(item.guideline_source),
    callTimestamp: str(item.call_timestamp),
    triageCompletedAt: str(item.triage_completed_at) || null,
    protocolSource: str(item.protocol_source) || null,
  };
}

// ─── GET /api/patients ────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  try {
    const table = process.env.DYNAMO_TABLE_RESULTS ?? "CallResults";
    const result = await docClient.send(
      new ScanCommand({ TableName: table })
    );

    const items = result.Items ?? [];
    const patients = items
      .map((item) => mapItem(item as Record<string, unknown>))
      .sort((a, b) => urgencyPriority(a) - urgencyPriority(b));

    const stats: DashboardStats = {
      total: patients.length,
      red: patients.filter((p) => p.triageStatus === "RED").length,
      yellow: patients.filter((p) => p.triageStatus === "YELLOW").length,
      green: patients.filter((p) => p.triageStatus === "GREEN").length,
      incomplete: patients.filter((p) => p.triageStatus === "INCOMPLETE").length,
      acknowledged: patients.filter((p) => p.nurseAcknowledged).length,
      pending: patients.filter((p) => !p.nurseAcknowledged).length,
    };

    return NextResponse.json({ patients, stats });
  } catch (err) {
    console.error("GET /api/patients error:", err);
    return NextResponse.json(
      { error: "Failed to load patient records" },
      { status: 500 }
    );
  }
}
