import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { validatePatientId, validateCallId } from "@sentinel/validation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

// ─── AWS clients ──────────────────────────────────────────────────────────────

const dynamoClient = new DynamoDBClient({
  region: process.env["AWS_REGION"] ?? "us-east-1",
  ...(process.env["DYNAMO_ENDPOINT"]
    ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
    : {}),
});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (
  event: { patientId: string; phoneNumber: string; callId: string }
): Promise<object> => {

  // STEP 1 — Validate input
  if (!validatePatientId(event.patientId)) {
    return { statusCode: 400, error: "Invalid patientId format" };
  }
  if (!validateCallId(event.callId)) {
    return { statusCode: 400, error: "Invalid callId format" };
  }
  if (!event.phoneNumber) {
    return { statusCode: 400, error: "patientId, phoneNumber, callId required" };
  }

  // STEP 2 — Confirm protocol exists
  const protocolResp = await docClient.send(
    new GetCommand({
      TableName: process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols",
      Key: { patient_id: event.patientId },
    })
  );

  if (!protocolResp.Item) {
    return {
      statusCode: 404,
      error: "No protocol found — cannot initiate call",
    };
  }

  // STEP 3 — Write initial CallResults record
  await docClient.send(
    new PutCommand({
      TableName: process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults",
      Item: {
        call_id:              event.callId,
        patient_id:           event.patientId,
        call_status:          "IN_PROGRESS",
        call_timestamp:       new Date().toISOString(),
        variables:            {},
        unresolved_variables: [],
        transcript_warnings:  [],
        nurse_acknowledged:   false,
      },
    })
  );

  // STEP 4 — Place outbound call via Connect
  const contactFlowId = process.env["CONNECT_CONTACT_FLOW_ID"] ?? "";
  const queueId       = process.env["CONNECT_QUEUE_ID"]        ?? "";

  if (!contactFlowId || !queueId) {
    console.log("Connect not configured — skipping call placement");
    return {
      statusCode: 200,
      contactId:  "PENDING-CONNECT-CONFIG",
      callId:     event.callId,
      patientId:  event.patientId,
      status:     "QUEUED",
    };
  }

  // Connect is configured — place the outbound call with retry
  const { ConnectClient, StartOutboundVoiceContactCommand } =
    await import("@aws-sdk/client-connect");

  const connectClient = new ConnectClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
  });

  const maxRetries = parseInt(process.env["CALL_RETRY_ATTEMPTS"] ?? "3", 10);
  let contactId: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const connectResp = await connectClient.send(
        new StartOutboundVoiceContactCommand({
          DestinationPhoneNumber: event.phoneNumber,
          InstanceId:             process.env["CONNECT_INSTANCE_ID"] ?? "",
          ContactFlowId:          contactFlowId,
          QueueId:                queueId,
          Attributes: {
            patientId: event.patientId,
            callId:    event.callId,
          },
        })
      );
      contactId = connectResp.ContactId;
      break;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Connect attempt ${attempt}/${maxRetries} failed: ${msg}`);

      if (attempt === maxRetries) {
        // Mark the record as INCOMPLETE after all retries exhausted
        await docClient.send(
          new UpdateCommand({
            TableName: process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults",
            Key: { call_id: event.callId, patient_id: event.patientId },
            UpdateExpression: "SET call_status = :s",
            ExpressionAttributeValues: { ":s": "INCOMPLETE" },
          })
        );
        return {
          statusCode: 500,
          error:      `Call placement failed after ${maxRetries} attempts`,
          callId:     event.callId,
          patientId:  event.patientId,
        };
      }
    }
  }

  // STEP 5 — Return success
  return {
    statusCode: 200,
    contactId:  contactId ?? "PENDING",
    callId:     event.callId,
    patientId:  event.patientId,
    status:     "INITIATED",
  };
};
