import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import fetch from "node-fetch";
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

function fhirBase(): string {
  return process.env["FHIR_BASE_URL"] ?? "http://localhost:8080/fhir";
}

// ─── FHIR phone lookup ────────────────────────────────────────────────────────

interface FhirTelecom {
  system?: string;
  value?:  string;
}
interface FhirPatientResource {
  telecom?: FhirTelecom[];
  name?: Array<{ given?: string[] }>;
}

interface PatientInfo {
  phone: string | null;
  name:  string;
}

async function getPatientInfo(patientId: string): Promise<PatientInfo> {
  try {
    const res = await fetch(`${fhirBase()}/Patient/${patientId}`);
    if (!res.ok) return { phone: null, name: "there" };
    const patient = (await res.json()) as FhirPatientResource;
    const phone = (patient.telecom ?? []).find((t) => t.system === "phone")?.value ?? null;
    const name  = patient.name?.[0]?.given?.[0] ?? "there";
    return { phone, name };
  } catch {
    return { phone: null, name: "there" };
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (
  event: { patientId: string; callId: string; phoneNumber?: string }
): Promise<object> => {

  // STEP 1 — Validate input
  if (!validatePatientId(event.patientId)) {
    return { statusCode: 400, error: "Invalid patientId format" };
  }
  if (!validateCallId(event.callId)) {
    return { statusCode: 400, error: "Invalid callId format" };
  }

  // STEP 1b — Resolve phone + name from FHIR (phone can be overridden by caller)
  const patientInfo = await getPatientInfo(event.patientId);
  let patientPhone  = event.phoneNumber ?? patientInfo.phone;
  const patientName = patientInfo.name;

  if (!patientPhone) {
    return {
      statusCode: 400,
      error:      `No phone number found in FHIR for patient ${event.patientId}`,
    };
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
          DestinationPhoneNumber: patientPhone,
          InstanceId:             process.env["CONNECT_INSTANCE_ID"] ?? "",
          ContactFlowId:          contactFlowId,
          QueueId:                queueId,
          Attributes: {
            patientId:    event.patientId,
            callId:       event.callId,
            patientName,
            kvsStreamArn: process.env["KVS_STREAM_ARN"] ?? "",
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
