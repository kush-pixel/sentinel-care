/**
 * call-bridge/handler.ts — Lightweight bridge Lambda invoked by Amazon Connect.
 *
 * Amazon Connect invokes this synchronously with an 8-second timeout.
 * This handler immediately fires sentinel-nova-sonic asynchronously (InvocationType: "Event")
 * and returns to Connect within ~1 second, keeping the call alive.
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { validatePatientId } from "@sentinel/validation";
import { auditLog } from "@sentinel/audit";

// ─── Connect event shape ──────────────────────────────────────────────────────

interface ConnectAttributes {
  patientId?: string;
  callId?:    string;
  [key: string]: string | undefined;
}

interface ConnectContactData {
  Attributes?: ConnectAttributes;
  ContactId?:  string;
}

interface ConnectEvent {
  Details?: {
    ContactData?: ConnectContactData;
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (event: ConnectEvent): Promise<Record<string, string>> => {
  const attrs      = event.Details?.ContactData?.Attributes ?? {};
  const contactId  = event.Details?.ContactData?.ContactId  ?? "";
  const patientId  = attrs["patientId"] ?? "";
  const callId     = attrs["callId"]    ?? ("CALL-" + Date.now().toString(16));

  // Validate patientId — return error map if invalid (Connect reads it as error)
  if (!patientId || !validatePatientId(patientId)) {
    console.error(`[call-bridge] Invalid patientId: "${patientId}"`);
    return { status: "ERROR", error: "invalid_patient_id" };
  }

  const callCompleteArn = process.env["LAMBDA_ARN_CALL_COMPLETE"] ?? "";
  if (!callCompleteArn) {
    console.error("[call-bridge] LAMBDA_ARN_CALL_COMPLETE not configured");
    return { status: "ERROR", error: "call_complete_not_configured" };
  }

  // Fire call-complete asynchronously — computes unresolved vars and triggers triage engine
  const lambdaClient = new LambdaClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
  });

  const payload = JSON.stringify({
    patientId,
    callId,
    callStatus: "COMPLETE",
  });

  await lambdaClient.send(new InvokeCommand({
    FunctionName:   callCompleteArn,
    InvocationType: "Event",
    Payload:        Buffer.from(payload),
  }));

  auditLog({
    eventType:   "DATA_ACCESS",
    patientId,
    performedBy: "SYSTEM",
    action:      `call-complete fired async for contactId=${contactId}`,
    timestamp:   new Date().toISOString(),
    success:     true,
  });

  console.log(`[call-bridge] call-complete fired async — patientId=${patientId} callId=${callId} contactId=${contactId}`);

  return {
    status:    "STARTED",
    patientId,
    callId,
    contactId,
  };
};
