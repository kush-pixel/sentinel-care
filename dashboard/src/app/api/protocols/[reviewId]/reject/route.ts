import { NextRequest, NextResponse } from "next/server";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/dynamo";
import { checkRateLimit } from "@/lib/rate-limit";

interface RejectBody {
  patientId: string;
  reviewedBy: string;
  rejectionReason: string;
  reviewNotes?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { reviewId: string } }
): Promise<NextResponse> {
  const rateLimit = checkRateLimit("protocols-reject-api", {
    maxRequests: 10,
    windowMs: 60000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = (await req.json()) as RejectBody;
    const { patientId, reviewedBy, rejectionReason, reviewNotes } = body;
    const { reviewId } = params;

    if (!patientId || !/^P\d{3}$/.test(patientId)) {
      return NextResponse.json(
        { error: "Invalid patientId format" },
        { status: 400 }
      );
    }
    if (!reviewedBy) {
      return NextResponse.json(
        { error: "reviewedBy is required" },
        { status: 400 }
      );
    }
    if (!rejectionReason || !rejectionReason.trim()) {
      return NextResponse.json(
        { error: "rejectionReason is required" },
        { status: 400 }
      );
    }

    const reviewsTable = process.env.DYNAMO_TABLE_REVIEWS ?? "ProtocolReview";
    const now = new Date().toISOString();

    await docClient.send(
      new UpdateCommand({
        TableName: reviewsTable,
        Key: { review_id: reviewId, patient_id: patientId },
        UpdateExpression:
          "SET #s = :s, reviewed_by = :rb, reviewed_at = :ra, rejection_reason = :rr, review_notes = :rn",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": "REJECTED",
          ":rb": reviewedBy,
          ":ra": now,
          ":rr": rejectionReason.trim(),
          ":rn": reviewNotes ?? null,
        },
      })
    );

    // Audit log
    console.log(
      `[AUDIT] PROTOCOL_REJECTED patient=${patientId} reviewId=${reviewId} by=${reviewedBy} reason=${rejectionReason.trim()}`
    );

    return NextResponse.json({
      success: true,
      reviewId,
      patientId,
      status: "REJECTED",
    });
  } catch (err) {
    console.error(`POST /api/protocols/${params.reviewId}/reject error:`, err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
