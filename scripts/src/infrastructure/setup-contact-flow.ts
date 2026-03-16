/**
 * setup-contact-flow.ts — Creates the Sentinel Nova Sonic outbound contact flow
 * in Amazon Connect programmatically, then associates it with the phone number.
 *
 * Run: cd scripts && npm run setup:contact-flow
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import {
  ConnectClient,
  UpdateContactFlowContentCommand,
  ListLambdaFunctionsCommand,
  AssociateLambdaFunctionCommand,
  ListPhoneNumbersV2Command,
  AssociatePhoneNumberContactFlowCommand,
} from "@aws-sdk/client-connect";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ─── Constants ────────────────────────────────────────────────────────────────

const INSTANCE_ID    = "40725174-b7f7-4388-8ea4-e761fd3c18fe";
const FLOW_ID        = "45faa7a9-62ac-468c-a186-cc3f012766f7";
const REGION         = process.env["AWS_REGION"] ?? "us-east-1";
const FLOW_NAME      = "sentinel-nova-sonic-outbound";
const LAMBDA_ARN     = "arn:aws:lambda:us-east-1:629843009128:function:sentinel-call-bridge";
const PHONE_NUMBER   = "+17208446427";
const SEP            = "─────────────────────────────────────────────";

// ─── Flow Content ─────────────────────────────────────────────────────────────

const LEX_ALIAS_ARN = "arn:aws:lex:us-east-1:629843009128:bot-alias/KEVYFJMTZ5/YOH9BNHFPG";

const FLOW_CONTENT = JSON.stringify({
  Version: "2019-10-30",
  StartAction: "GetCustomerInput",
  Actions: [
    {
      // Greeting lives here — plays exactly once when Connect starts the Lex session.
      // lex-fulfillment Lambda returns only the question on first turn (no duplicate greeting).
      Identifier: "GetCustomerInput",
      Type: "ConnectParticipantWithLexBot",
      Parameters: {
        Text: "Hello $.Attributes.patientName, this is your care team calling for a quick follow-up after your recent hospital stay.",
        LexV2Bot: {
          AliasArn: LEX_ALIAS_ARN,
        },
        LexSessionAttributes: {
          patientId:   "$.Attributes.patientId",
          callId:      "$.Attributes.callId",
          patientName: "$.Attributes.patientName",
        },
        LexTimeoutSeconds: { Text: "300" },
      },
      Transitions: {
        NextAction: "InvokeTriage",
        Conditions: [
          {
            NextAction: "InvokeTriage",
            Condition: {
              Operator: "Equals",
              Operands: ["PatientFollowUp"],
            },
          },
        ],
        Errors: [
          { NextAction: "Disconnect", ErrorType: "InputTimeLimitExceeded" },
          { NextAction: "Disconnect", ErrorType: "NoMatchingCondition" },
          { NextAction: "Disconnect", ErrorType: "NoMatchingError" },
        ],
      },
    },
    {
      Identifier: "InvokeTriage",
      Type: "InvokeLambdaFunction",
      Parameters: {
        LambdaFunctionARN:          LAMBDA_ARN,
        InvocationTimeLimitSeconds: "8",
        LambdaInvocationAttributes: {
          patientId: "$.Attributes.patientId",
          callId:    "$.Attributes.callId",
          contactId: "$.ContactId",
        },
        ResponseValidation: { ResponseType: "STRING_MAP" },
      },
      Transitions: {
        NextAction: "Disconnect",
        Errors: [{ NextAction: "Disconnect", ErrorType: "NoMatchingError" }],
      },
    },
    {
      Identifier: "Disconnect",
      Type: "DisconnectParticipant",
      Parameters: {},
      Transitions: {},
    },
  ],
});

// ─── Connect API problem types ────────────────────────────────────────────────

interface FlowProblem {
  message?: string;
}

// ─── Step 1: Update the contact flow content ─────────────────────────────────

async function updateFlowContent(client: ConnectClient): Promise<void> {
  try {
    await client.send(new UpdateContactFlowContentCommand({
      InstanceId:    INSTANCE_ID,
      ContactFlowId: FLOW_ID,
      Content:       FLOW_CONTENT,
    }));
  } catch (err: unknown) {
    const name = (err as { name?: string }).name ?? "";
    if (name === "InvalidContactFlowException") {
      // The Connect API rejects certain parameters (e.g. LexV2Bot in GetParticipantInput)
      // that can only be set via the Connect console UI.
      // Extract the problem details if available.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const problems: FlowProblem[] = (err as any).problems ?? [];
      const detail = problems.map((p) => p.message ?? "").filter(Boolean).join("; ") ||
        "GetParticipantInput + LexV2Bot is not accepted by the API";
      throw Object.assign(
        new Error(`Connect API rejected flow content: ${detail}`),
        { name: "InvalidContactFlowException", problems },
      );
    }
    throw err;
  }
}

// ─── Step 3: Associate Lambda with Connect instance ───────────────────────────

async function associateLambda(client: ConnectClient): Promise<boolean> {
  // Check if already associated
  const list = await client.send(new ListLambdaFunctionsCommand({
    InstanceId: INSTANCE_ID,
  }));

  const already = (list.LambdaFunctions ?? []).includes(LAMBDA_ARN);
  if (already) {
    console.log("  (Lambda already associated with Connect instance)");
    return false;
  }

  await client.send(new AssociateLambdaFunctionCommand({
    InstanceId:  INSTANCE_ID,
    FunctionArn: LAMBDA_ARN,
  }));
  return true;
}

// ─── Step 4: Associate phone number with flow ────────────────────────────────

async function associatePhone(client: ConnectClient, flowId: string): Promise<void> {
  // Find the phone number ID
  let nextToken: string | undefined;
  let phoneNumberId: string | undefined;

  do {
    const resp = await client.send(new ListPhoneNumbersV2Command({
      InstanceId: INSTANCE_ID,
      ...(nextToken && { NextToken: nextToken }),
    }));

    const match = (resp.ListPhoneNumbersSummaryList ?? []).find(
      (p) => p.PhoneNumber === PHONE_NUMBER
    );
    if (match?.PhoneNumberId) {
      phoneNumberId = match.PhoneNumberId;
      break;
    }

    nextToken = resp.NextToken;
  } while (nextToken);

  if (!phoneNumberId) {
    throw new Error(`Phone number ${PHONE_NUMBER} not found in Connect instance`);
  }

  await client.send(new AssociatePhoneNumberContactFlowCommand({
    PhoneNumberId: phoneNumberId,
    InstanceId:    INSTANCE_ID,
    ContactFlowId: flowId,
  }));
}

// ─── Step 5: Update .env ─────────────────────────────────────────────────────

function updateEnvFile(flowId: string): void {
  const envPath = path.join(path.resolve(__dirname, "../../.."), ".env");
  let content   = fs.readFileSync(envPath, "utf8");

  const regex = /^CONNECT_CONTACT_FLOW_ID=.*$/m;
  if (regex.test(content)) {
    content = content.replace(regex, `CONNECT_CONTACT_FLOW_ID=${flowId}`);
  } else {
    content += `\nCONNECT_CONTACT_FLOW_ID=${flowId}`;
  }

  fs.writeFileSync(envPath, content, "utf8");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(SEP);
  console.log("SENTINEL — CONNECT CONTACT FLOW SETUP");
  console.log(SEP + "\n");

  const client = new ConnectClient({ region: REGION });

  // Step 1 — Update flow content
  console.log("STEP 1 — Updating contact flow content...");
  await updateFlowContent(client);
  console.log(`  ✓ Flow updated — single greeting with patient name, Lex with session attributes`);
  console.log(`  ✓ Flow ID: ${FLOW_ID}`);

  const flowId = FLOW_ID;

  // Step 3 — Associate Lambda
  console.log("\nSTEP 3 — Associating Lambda with Connect instance...");
  const wasNew = await associateLambda(client);
  if (wasNew) {
    console.log(`  ✓ Lambda associated with Connect`);
  } else {
    console.log(`  ✓ Lambda already associated`);
  }

  // Step 4 — Associate phone number
  console.log("\nSTEP 4 — Associating phone number with flow...");
  await associatePhone(client, flowId);
  console.log(`  ✓ Phone ${PHONE_NUMBER} associated with flow`);

  // Step 5 — Update .env
  console.log("\nSTEP 5 — Updating .env...");
  updateEnvFile(flowId);
  console.log(`  ✓ .env updated with CONNECT_CONTACT_FLOW_ID=${flowId}`);

  // Summary
  console.log("\n" + SEP);
  console.log("CONTACT FLOW SETUP COMPLETE");
  console.log(SEP);
  console.log(`  ✓ Contact flow created:  ${FLOW_NAME}`);
  console.log(`  ✓ Flow ID:               ${flowId}`);
  console.log(`  ✓ Lambda associated with Connect`);
  console.log(`  ✓ Phone ${PHONE_NUMBER} associated with flow`);
  console.log(`  ✓ .env updated with CONNECT_CONTACT_FLOW_ID`);
  console.log(SEP);
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    console.error("setup:contact-flow failed:", err.message);
    console.error("  name:", (err as { name?: string }).name);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (err as any).$metadata;
    if (meta) console.error("  httpStatus:", meta.httpStatusCode, "requestId:", meta.requestId);
  } else {
    console.error("setup:contact-flow failed:", String(err));
  }
  process.exit(1);
});
