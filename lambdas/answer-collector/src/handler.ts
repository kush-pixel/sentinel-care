import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

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

export const handler = async (event: {
  Details?: {
    ContactData?: {
      Attributes?: {
        patientId?: string;
        callId?: string;
      };
    };
    Parameters?: {
      variable?: string;
      value?: string;
      confidence?: string;
    };
  };
}): Promise<object> => {

  // STEP 1 — Extract fields
  const patientId  = event.Details?.ContactData?.Attributes?.patientId;
  const callId     = event.Details?.ContactData?.Attributes?.callId;
  const variable   = event.Details?.Parameters?.variable;
  const rawValue   = event.Details?.Parameters?.value;
  const rawConf    = event.Details?.Parameters?.confidence;

  if (!patientId || !callId || !variable || rawValue === undefined || rawConf === undefined) {
    return { success: false, error: "Missing fields" };
  }

  // STEP 2 — Parse value and confidence
  const confidence = parseFloat(rawConf);

  let parsedValue: number | boolean | string;
  if (rawValue === "true") {
    parsedValue = true;
  } else if (rawValue === "false") {
    parsedValue = false;
  } else if (!isNaN(Number(rawValue))) {
    parsedValue = Number(rawValue);
  } else {
    parsedValue = rawValue;
  }

  // STEP 3 — Get existing CallResults record (create empty if absent)
  const existing = await docClient.send(
    new GetCommand({
      TableName: process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults",
      Key: { call_id: callId, patient_id: patientId },
    })
  );

  if (!existing.Item) {
    await docClient.send(
      new PutCommand({
        TableName: process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults",
        Item: {
          call_id:              callId,
          patient_id:           patientId,
          call_status:          "IN_PROGRESS",
          call_timestamp:       new Date().toISOString(),
          variables:            {},
          unresolved_variables: [],
          transcript_warnings:  [],
          nurse_acknowledged:   false,
        },
      })
    );
  }

  // STEP 4 — Merge new answer into existing variables map
  const existingVariables = (
    existing.Item?.["variables"] as Record<
      string,
      { value: number | boolean | string; confidence: number }
    > | undefined
  ) ?? {};

  existingVariables[variable] = { value: parsedValue, confidence };

  // STEP 5 — Write merged variables back
  await docClient.send(
    new UpdateCommand({
      TableName: process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults",
      Key: { call_id: callId, patient_id: patientId },
      UpdateExpression: "SET #vars = :v, updated_at = :u",
      ExpressionAttributeNames: { "#vars": "variables" },
      ExpressionAttributeValues: {
        ":v": existingVariables,
        ":u": new Date().toISOString(),
      },
    })
  );

  // STEP 6 — Return
  return {
    success:      true,
    variable,
    value:        parsedValue,
    confidence,
    totalAnswers: Object.keys(existingVariables).length,
  };
};
