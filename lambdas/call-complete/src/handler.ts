import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
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
  event: {
    patientId:  string;
    callId:     string;
    callStatus: "COMPLETE" | "INCOMPLETE";
  }
): Promise<object> => {

  // STEP 1 — Validate input
  if (!event.patientId || !event.callId || !event.callStatus) {
    return { statusCode: 400, error: "patientId, callId, callStatus required" };
  }

  if (event.callStatus !== "COMPLETE" && event.callStatus !== "INCOMPLETE") {
    return {
      statusCode: 400,
      error: "callStatus must be COMPLETE or INCOMPLETE",
    };
  }

  // STEP 2 — Get current CallResults
  const callResp = await docClient.send(
    new GetCommand({
      TableName: process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults",
      Key: { call_id: event.callId, patient_id: event.patientId },
    })
  );

  if (!callResp.Item) {
    return {
      statusCode: 404,
      error: "Call result not found",
    };
  }

  const callResult = callResp.Item as {
    variables?: Record<string, unknown>;
  };

  // STEP 3 — Get protocol to find expected variables
  const protocolResp = await docClient.send(
    new GetCommand({
      TableName: process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols",
      Key: { patient_id: event.patientId },
    })
  );

  const protocol = protocolResp.Item?.["protocol"] as {
    question_priority?: string[];
  } | undefined;

  // STEP 4 — Calculate unresolved variables
  const answeredVariables  = Object.keys(callResult.variables ?? {});
  const expectedVariables  = protocol?.question_priority ?? [];
  const unresolvedVariables = expectedVariables.filter(
    (v) => !answeredVariables.includes(v)
  );

  // STEP 5 — Update CallResults with final status
  await docClient.send(
    new UpdateCommand({
      TableName: process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults",
      Key: { call_id: event.callId, patient_id: event.patientId },
      UpdateExpression:
        "SET call_status = :cs, unresolved_variables = :uv, call_completed_at = :cc",
      ExpressionAttributeValues: {
        ":cs": event.callStatus,
        ":uv": unresolvedVariables,
        ":cc": new Date().toISOString(),
      },
    })
  );

  // STEP 6 — Trigger triage engine (only if ARN configured)
  const triageArn = process.env["LAMBDA_ARN_TRIAGE_ENGINE"] ?? "";

  if (triageArn) {
    const { LambdaClient, InvokeCommand } =
      await import("@aws-sdk/client-lambda");

    const lambdaClient = new LambdaClient({
      region: process.env["AWS_REGION"] ?? "us-east-1",
    });

    await lambdaClient.send(
      new InvokeCommand({
        FunctionName:   triageArn,
        InvocationType: "Event",
        Payload:        Buffer.from(
          JSON.stringify({
            callId:    event.callId,
            patientId: event.patientId,
          })
        ),
      })
    );
  } else {
    console.log("Triage engine ARN not configured — skipping invocation");
  }

  // STEP 7 — Return
  return {
    statusCode:      200,
    callId:          event.callId,
    patientId:       event.patientId,
    callStatus:      event.callStatus,
    unresolvedCount: unresolvedVariables.length,
    triageTriggered: !!triageArn,
  };
};
