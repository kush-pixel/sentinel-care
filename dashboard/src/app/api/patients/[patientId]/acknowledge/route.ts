import { NextRequest, NextResponse } from "next/server";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/dynamo";
import { checkRateLimit } from "@/lib/rate-limit";

interface AcknowledgeBody {
  callId: string;
  acknowledgedBy: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { patientId: string } }
): Promise<NextResponse> {
  const rateLimit = checkRateLimit("acknowledge-api", {
    maxRequests: 20,
    windowMs: 60000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = (await req.json()) as AcknowledgeBody;
    const { callId, acknowledgedBy } = body;
    const { patientId } = params;

    if (!callId || !acknowledgedBy || !patientId) {
      return NextResponse.json(
        { error: "callId, acknowledgedBy, and patientId are required" },
        { status: 400 }
      );
    }

    const table = process.env.DYNAMO_TABLE_RESULTS ?? "CallResults";

    await docClient.send(
      new UpdateCommand({
        TableName: table,
        Key: { call_id: callId, patient_id: patientId },
        UpdateExpression:
          "SET nurse_acknowledged = :ack, acknowledged_by = :by, acknowledged_at = :at",
        ExpressionAttributeValues: {
          ":ack": true,
          ":by": acknowledgedBy,
          ":at": new Date().toISOString(),
        },
      })
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("POST /api/patients/[patientId]/acknowledge error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
