import { NextResponse } from "next/server";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/dynamo";
import { checkRateLimit } from "@/lib/rate-limit";
import type { ProtocolReviewRecord, ReviewStats } from "@/lib/types";

// ─── DynamoDB item → ProtocolReviewRecord ─────────────────────────────────────

function mapReview(item: Record<string, unknown>): ProtocolReviewRecord {
  function str(v: unknown, fallback = ""): string {
    return typeof v === "string" ? v : fallback;
  }
  function strNull(v: unknown): string | null {
    return typeof v === "string" && v ? v : null;
  }
  function num(v: unknown, fallback = 0): number {
    return typeof v === "number" ? v : fallback;
  }

  const validStatuses = [
    "PENDING_REVIEW",
    "AUTO_APPROVED",
    "APPROVED",
    "REJECTED",
  ] as const;
  type Status = (typeof validStatuses)[number];
  const rawStatus = str(item["status"], "PENDING_REVIEW");
  const status: Status = validStatuses.includes(rawStatus as Status)
    ? (rawStatus as Status)
    : "PENDING_REVIEW";

  const rawLaceComponents = item["lace_components"] as
    | { L?: number; A?: number; C?: number; E?: number }
    | undefined;
  const laceComponents = rawLaceComponents
    ? {
        L: rawLaceComponents.L ?? 0,
        A: rawLaceComponents.A ?? 0,
        C: rawLaceComponents.C ?? 0,
        E: rawLaceComponents.E ?? 0,
      }
    : null;

  return {
    reviewId: str(item["review_id"]),
    patientId: str(item["patient_id"]),
    status,
    confidenceScore: num(item["confidence_score"]),
    pendingReason: strNull(item["pending_reason"]),
    autoApprovalReason: strNull(item["auto_approval_reason"]),
    protocolSource: str(item["protocol_source"], "ai_generated"),
    conditionCode: str(item["condition_code"]),
    laceScore: num(item["lace_score"]),
    laceRiskLevel: str(item["lace_risk_level"], "UNKNOWN"),
    laceComponents,
    aiModelUsed: strNull(item["ai_model_used"]),
    rejectionReason: strNull(item["rejection_reason"]),
    reviewedBy: strNull(item["reviewed_by"]),
    reviewedAt: strNull(item["reviewed_at"]),
    reviewNotes: strNull(item["review_notes"]),
    createdAt: str(item["created_at"]),
    approvedAt: strNull(item["approved_at"]),
    ruleVersionId: strNull(item["rule_version_id"]),
    ruleVersion: typeof item["rule_version"] === "number" ? item["rule_version"] : null,
    ruleEffectiveFrom: strNull(item["rule_effective_from"]),
    isRegeneration: item["is_regeneration"] === true,
    previousReviewId: strNull(item["previous_review_id"]),
    regenerationReason: strNull(item["regeneration_reason"]),
    regenerationCount: typeof item["regeneration_count"] === "number" ? item["regeneration_count"] : 0,
    regeneratedAs: strNull(item["regenerated_as"]),
    regenerationTriggeredAt: strNull(item["regeneration_triggered_at"]),
    protocol: (item["protocol"] as ProtocolReviewRecord["protocol"]) ?? null,
  };
}

// ─── GET /api/protocols ───────────────────────────────────────────────────────
// Returns ONLY ProtocolReview records with status = PENDING_REVIEW.
// Never returns AUTO_APPROVED, APPROVED, or REJECTED records in the reviews array.
// Deduplicates by patient_id: keeps the most recent PENDING_REVIEW record per patient.
// Stats are computed from ALL records for accurate counts.

export async function GET(): Promise<NextResponse> {
  const rateLimit = checkRateLimit("protocols-api");
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const table = process.env.DYNAMO_TABLE_REVIEWS ?? "ProtocolReview";
    const result = await docClient.send(new ScanCommand({ TableName: table }));

    const allReviews = (result.Items ?? []).map((item) =>
      mapReview(item as Record<string, unknown>)
    );

    // Stats computed from ALL records (accurate counts across all statuses)
    const stats: ReviewStats = {
      total:       allReviews.length,
      pending:     allReviews.filter((r) => r.status === "PENDING_REVIEW").length,
      approved:    allReviews.filter((r) => r.status === "APPROVED").length,
      rejected:    allReviews.filter((r) => r.status === "REJECTED").length,
      autoApproved: allReviews.filter((r) => r.status === "AUTO_APPROVED").length,
    };

    // Display list: ONLY PENDING_REVIEW, sorted newest first, ONE per patient
    const pendingSorted = allReviews
      .filter((r) => r.status === "PENDING_REVIEW")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // Safeguard: deduplicate by patient_id (case-insensitive), keep most recent
    const seenPatients = new Set<string>();
    const reviews = pendingSorted.filter((r) => {
      const pid = r.patientId.toLowerCase();
      if (seenPatients.has(pid)) return false;
      seenPatients.add(pid);
      return true;
    });

    // Safeguard: assert no duplicate patient_ids before returning
    const patientIds = reviews.map((r) => r.patientId.toLowerCase());
    const uniqueIds  = new Set(patientIds);
    if (patientIds.length !== uniqueIds.size) {
      console.error("DUPLICATE PATIENT IDS IN PROTOCOL REVIEW — dedup failed");
    }

    return NextResponse.json({ reviews, stats });
  } catch (err) {
    console.error("GET /api/protocols error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
