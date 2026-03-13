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
    isRegeneration: item["is_regeneration"] === true,
    previousReviewId: strNull(item["previous_review_id"]),
    regenerationReason: strNull(item["regeneration_reason"]),
    regenerationCount: typeof item["regeneration_count"] === "number" ? item["regeneration_count"] : 0,
    regeneratedAs: strNull(item["regenerated_as"]),
    regenerationTriggeredAt: strNull(item["regeneration_triggered_at"]),
    protocol: (item["protocol"] as ProtocolReviewRecord["protocol"]) ?? null,
  };
}

// ─── Sort order: PENDING first, then by created_at desc ──────────────────────

function reviewSortOrder(r: ProtocolReviewRecord): number {
  if (r.status === "PENDING_REVIEW") return 0;
  if (r.status === "AUTO_APPROVED") return 1;
  if (r.status === "APPROVED") return 2;
  return 3; // REJECTED
}

// ─── GET /api/protocols ───────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const rateLimit = checkRateLimit("protocols-api");
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const table = process.env.DYNAMO_TABLE_REVIEWS ?? "ProtocolReview";
    const result = await docClient.send(new ScanCommand({ TableName: table }));

    const items = result.Items ?? [];
    const reviews = items
      .map((item) => mapReview(item as Record<string, unknown>))
      .sort((a, b) => {
        const orderDiff = reviewSortOrder(a) - reviewSortOrder(b);
        if (orderDiff !== 0) return orderDiff;
        return b.createdAt.localeCompare(a.createdAt);
      });

    const stats: ReviewStats = {
      total: reviews.length,
      pending: reviews.filter((r) => r.status === "PENDING_REVIEW").length,
      approved: reviews.filter((r) => r.status === "APPROVED").length,
      rejected: reviews.filter((r) => r.status === "REJECTED").length,
      autoApproved: reviews.filter((r) => r.status === "AUTO_APPROVED").length,
    };

    return NextResponse.json({ reviews, stats });
  } catch (err) {
    console.error("GET /api/protocols error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
