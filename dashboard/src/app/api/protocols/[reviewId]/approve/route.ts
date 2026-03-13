import { NextRequest, NextResponse } from "next/server";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/dynamo";
import { checkRateLimit } from "@/lib/rate-limit";

interface ApproveBody {
  patientId: string;
  reviewedBy: string;
  reviewNotes?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { reviewId: string } }
): Promise<NextResponse> {
  const rateLimit = checkRateLimit("protocols-approve-api", {
    maxRequests: 10,
    windowMs: 60000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = (await req.json()) as ApproveBody;
    const { patientId, reviewedBy, reviewNotes } = body;
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

    const reviewsTable = process.env.DYNAMO_TABLE_REVIEWS ?? "ProtocolReview";
    const protocolsTable =
      process.env.DYNAMO_TABLE_PROTOCOLS ?? "TriageProtocols";
    const now = new Date().toISOString();

    // STEP 1 — Read the existing review to get protocol data
    const getResult = await docClient.send(
      new GetCommand({
        TableName: reviewsTable,
        Key: { review_id: reviewId, patient_id: patientId },
      })
    );

    if (!getResult.Item) {
      return NextResponse.json(
        { error: "Protocol review not found" },
        { status: 404 }
      );
    }

    const review = getResult.Item as Record<string, unknown>;

    // STEP 2 — Update ProtocolReview to APPROVED
    await docClient.send(
      new UpdateCommand({
        TableName: reviewsTable,
        Key: { review_id: reviewId, patient_id: patientId },
        UpdateExpression:
          "SET #s = :s, reviewed_by = :rb, reviewed_at = :ra, review_notes = :rn, approved_at = :aa",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": "APPROVED",
          ":rb": reviewedBy,
          ":ra": now,
          ":rn": reviewNotes ?? null,
          ":aa": now,
        },
      })
    );

    // STEP 3 — Copy protocol to TriageProtocols
    await docClient.send(
      new PutCommand({
        TableName: protocolsTable,
        Item: {
          patient_id: patientId,
          protocol: review["protocol"],
          lace_score: review["lace_score"] ?? 0,
          lace_risk_level: review["lace_risk_level"] ?? "UNKNOWN",
          lace_components: review["lace_components"] ?? null,
          created_at: now,
          approved_by: reviewedBy,
          review_id: reviewId,
        },
      })
    );

    // STEP 4 — Audit log
    console.log(
      `[AUDIT] PROTOCOL_APPROVED patient=${patientId} reviewId=${reviewId} by=${reviewedBy}`
    );

    return NextResponse.json({
      success: true,
      reviewId,
      patientId,
      status: "APPROVED",
      protocolCopiedToTriageProtocols: true,
    });
  } catch (err) {
    console.error(`POST /api/protocols/${params.reviewId}/approve error:`, err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
