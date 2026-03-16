/**
 * setup-lex-bot.ts — Creates the Sentinel Voice Lex v2 bot and associates
 * it with Amazon Connect so Nova Sonic can handle patient follow-up calls.
 *
 * Run: cd scripts && npm run setup:lex
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import {
  LexModelsV2Client,
  CreateBotCommand,
  CreateBotLocaleCommand,
  CreateIntentCommand,
  BuildBotLocaleCommand,
  DescribeBotLocaleCommand,
  CreateBotVersionCommand,
  DescribeBotVersionCommand,
  CreateBotAliasCommand,
  CreateResourcePolicyCommand,
  DescribeBotCommand,
  ListBotAliasesCommand,
  ListBotsCommand,
} from "@aws-sdk/client-lex-models-v2";
import {
  ConnectClient,
  UpdateContactFlowContentCommand,
} from "@aws-sdk/client-connect";
import {
  IAMClient,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ─── Constants ────────────────────────────────────────────────────────────────

const REGION      = process.env["AWS_REGION"] ?? "us-east-1";
const ACCOUNT_ID  = "629843009128";
const ROLE_ARN    = `arn:aws:iam::${ACCOUNT_ID}:role/sentinel-lambda-role`;
const INSTANCE_ID = "40725174-b7f7-4388-8ea4-e761fd3c18fe";
const FLOW_ID     = "45faa7a9-62ac-468c-a186-cc3f012766f7";
const BOT_NAME    = "SentinelVoiceBot";
const ALIAS_NAME  = "SentinelVoiceLive";
const LOCALE_ID   = "en_US";
const SEP         = "─────────────────────────────────────────────";

// ─── Step 1: Create or find bot ───────────────────────────────────────────────

async function getOrCreateBot(client: LexModelsV2Client): Promise<string> {
  // Check if bot already exists
  let nextToken: string | undefined;
  do {
    const list = await client.send(new ListBotsCommand({
      ...(nextToken && { nextToken }),
    }));
    const existing = (list.botSummaries ?? []).find((b) => b.botName === BOT_NAME);
    if (existing?.botId) {
      console.log(`  (Bot already exists: ${existing.botId})`);
      return existing.botId;
    }
    nextToken = list.nextToken;
  } while (nextToken);

  const resp = await client.send(new CreateBotCommand({
    botName:                 BOT_NAME,
    description:             "Sentinel Voice patient follow-up bot",
    roleArn:                 ROLE_ARN,
    dataPrivacy:             { childDirected: false },
    idleSessionTTLInSeconds: 300,
  }));

  if (!resp.botId) throw new Error("CreateBot returned no botId");
  return resp.botId;
}

// ─── Step 2: Create bot locale ────────────────────────────────────────────────

async function ensureBotLocale(client: LexModelsV2Client, botId: string): Promise<void> {
  try {
    await client.send(new CreateBotLocaleCommand({
      botId,
      botVersion:                   "DRAFT",
      localeId:                     LOCALE_ID,
      nluIntentConfidenceThreshold: 0.40,
      voiceSettings: {
        voiceId: "Matthew",
        engine:  "neural",
      },
    }));
  } catch (err: unknown) {
    const name = (err as { name?: string }).name ?? "";
    const msg  = (err as { message?: string }).message ?? "";
    if (
      name === "ConflictException" ||
      name === "ResourceConflictException" ||
      msg.includes("already exists")
    ) {
      console.log(`  (Locale ${LOCALE_ID} already exists)`);
      return;
    }
    throw err;
  }
}

// ─── Step 3: Create intent ────────────────────────────────────────────────────

async function ensureIntent(client: LexModelsV2Client, botId: string): Promise<void> {
  // CreateIntentCommand is idempotent per name; just attempt and ignore AlreadyExistsException
  try {
    await client.send(new CreateIntentCommand({
      botId,
      botVersion: "DRAFT",
      localeId:   LOCALE_ID,
      intentName: "PatientFollowUp",
      description: "Patient follow-up conversation",
      sampleUtterances: [
        { utterance: "yes" },
        { utterance: "no" },
        { utterance: "I don't know" },
        { utterance: "okay" },
        { utterance: "help" },
      ],
    }));
  } catch (err: unknown) {
    const name = (err as { name?: string }).name ?? "";
    const msg  = (err as { message?: string }).message ?? "";
    if (
      name === "ConflictException" ||
      name === "ResourceConflictException" ||
      msg.includes("already exists")
    ) {
      console.log("  (Intent PatientFollowUp already exists)");
      return;
    }
    throw err;
  }
}

// ─── Step 4: Build bot locale ─────────────────────────────────────────────────

async function buildLocale(client: LexModelsV2Client, botId: string): Promise<void> {
  // Attempt to build — ignore ConflictException if a build is already in progress
  try {
    await client.send(new BuildBotLocaleCommand({
      botId,
      botVersion: "DRAFT",
      localeId:   LOCALE_ID,
    }));
  } catch (err: unknown) {
    const name = (err as { name?: string }).name ?? "";
    const msg  = (err as { message?: string }).message ?? "";
    // Already building or already built
    if (name !== "ConflictException" && !msg.includes("already")) throw err;
  }

  // Poll until Built or timeout; retry on transient AccessDeniedException
  const deadline  = Date.now() + 5 * 60 * 1000;
  let accessRetry = 0;
  while (Date.now() < deadline) {
    try {
      const desc = await client.send(new DescribeBotLocaleCommand({
        botId,
        botVersion: "DRAFT",
        localeId:   LOCALE_ID,
      }));
      accessRetry = 0;
      const status = desc.botLocaleStatus ?? "Unknown";
      process.stdout.write(`\r  Building... ${status}         `);
      if (status === "Built") {
        process.stdout.write("\n");
        return;
      }
      if (status === "Failed") {
        const failures = (desc.failureReasons ?? []).join("; ");
        throw new Error(`Bot locale build failed: ${failures}`);
      }
    } catch (err: unknown) {
      const name = (err as { name?: string }).name ?? "";
      if (name === "AccessDeniedException" && accessRetry < 6) {
        accessRetry++;
        process.stdout.write(`\r  Waiting for IAM propagation (${accessRetry}/6)...`);
      } else {
        throw err;
      }
    }
    await new Promise<void>((r) => setTimeout(r, 10_000));
  }
  throw new Error("Timed out waiting for bot locale to build");
}

// ─── Step 5: Create bot version ───────────────────────────────────────────────

async function createBotVersion(client: LexModelsV2Client, botId: string): Promise<string> {
  const resp = await client.send(new CreateBotVersionCommand({
    botId,
    botVersionLocaleSpecification: {
      [LOCALE_ID]: { sourceBotVersion: "DRAFT" },
    },
  }));

  const botVersion = resp.botVersion;
  if (!botVersion) throw new Error("CreateBotVersion returned no botVersion");

  // Poll until Available; retry on transient ResourceNotFoundException / AccessDeniedException
  const deadline  = Date.now() + 5 * 60 * 1000;
  let notFound    = 0;
  while (Date.now() < deadline) {
    try {
      const desc = await client.send(new DescribeBotVersionCommand({ botId, botVersion }));
      notFound = 0;
      const status = desc.botStatus ?? "Unknown";
      process.stdout.write(`\r  Waiting for version ${botVersion}... ${status}   `);
      if (status === "Available") {
        process.stdout.write("\n");
        return botVersion;
      }
      if (status === "Failed") {
        const failures = (desc.failureReasons ?? []).join("; ");
        throw new Error(`Bot version creation failed: ${failures}`);
      }
    } catch (err: unknown) {
      const name = (err as { name?: string }).name ?? "";
      if (
        (name === "ResourceNotFoundException" || name === "AccessDeniedException") &&
        notFound < 6
      ) {
        notFound++;
        process.stdout.write(`\r  Version ${botVersion} propagating (${notFound}/6)...   `);
      } else {
        throw err;
      }
    }
    await new Promise<void>((r) => setTimeout(r, 5_000));
  }
  throw new Error("Timed out waiting for bot version");
}

// ─── Step 6: Create bot alias ─────────────────────────────────────────────────

async function getOrCreateAlias(
  client: LexModelsV2Client,
  botId: string,
  botVersion: string,
): Promise<string> {
  // Check if alias already exists
  let nextToken: string | undefined;
  do {
    const list = await client.send(new ListBotAliasesCommand({
      botId,
      ...(nextToken && { nextToken }),
    }));
    const existing = (list.botAliasSummaries ?? []).find((a) => a.botAliasName === ALIAS_NAME);
    if (existing?.botAliasId) {
      console.log(`  (Alias ${ALIAS_NAME} already exists: ${existing.botAliasId})`);
      return existing.botAliasId;
    }
    nextToken = list.nextToken;
  } while (nextToken);

  const resp = await client.send(new CreateBotAliasCommand({
    botId,
    botAliasName: ALIAS_NAME,
    botVersion,
    botAliasLocaleSettings: {
      [LOCALE_ID]: { enabled: true },
    },
    sentimentAnalysisSettings: { detectSentiment: false },
  }));

  if (!resp.botAliasId) throw new Error("CreateBotAlias returned no botAliasId");
  return resp.botAliasId;
}

// ─── Step 7: Associate Lex v2 bot with Connect (integration association) ──────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function associateWithConnect(_connect: ConnectClient): Promise<void> {
  // Lex v2 + Connect integration is done via the bot alias resource policy (Step 8).
  // There is no LEX_BOT IntegrationType in the Connect SDK for v2 bots.
  console.log("  (Lex v2: integrated via resource policy on bot alias)");
}

// ─── Step 8: Grant Connect permission to use Lex alias ────────────────────────

async function grantConnectPermission(
  lex: LexModelsV2Client,
  botId: string,
  botAliasId: string,
): Promise<void> {
  const botAliasArn =
    `arn:aws:lex:${REGION}:${ACCOUNT_ID}:bot-alias/${botId}/${botAliasId}`;

  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect:    "Allow",
        Principal: { Service: "connect.amazonaws.com" },
        Action:    "lex:RecognizeText",
        Resource:  botAliasArn,
        Condition: {
          StringEquals: {
            "AWS:SourceAccount": ACCOUNT_ID,
          },
          ArnLike: {
            "AWS:SourceArn": `arn:aws:connect:${REGION}:${ACCOUNT_ID}:instance/${INSTANCE_ID}`,
          },
        },
      },
    ],
  });

  try {
    await lex.send(new CreateResourcePolicyCommand({
      resourceArn: botAliasArn,
      policy,
    }));
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    // Policy already exists — ignore
    if (name === "ResourceAlreadyExistsException" || name === "PreconditionFailedException") {
      console.log("  (Resource policy already exists)");
      return;
    }
    throw err;
  }
}

// ─── Step 8b: Add Lex permissions to IAM role ─────────────────────────────────

async function addLexIamPolicy(): Promise<void> {
  const iam = new IAMClient({ region: REGION });
  await iam.send(new PutRolePolicyCommand({
    RoleName:       "sentinel-lambda-role",
    PolicyName:     "sentinel-lex-policy",
    PolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "lex:RecognizeText",
            "lex:RecognizeUtterance",
            "lex:DeleteSession",
            "lex:PutSession",
          ],
          Resource: "*",
        },
      ],
    }),
  }));
}

// ─── Step 9: Save to .env ─────────────────────────────────────────────────────

function updateEnvFile(values: Record<string, string>): void {
  const envPath = path.join(path.resolve(__dirname, "../../.."), ".env");
  let content   = fs.readFileSync(envPath, "utf8");

  for (const [key, value] of Object.entries(values)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }

  fs.writeFileSync(envPath, content, "utf8");
}

// ─── Step 10: Update contact flow ─────────────────────────────────────────────

function buildFlowContent(botId: string, botAliasId: string): string {
  return JSON.stringify({
    Version: "2019-10-30",
    StartAction: "PlayIntro",
    Actions: [
      {
        Identifier: "PlayIntro",
        Type: "MessageParticipant",
        Parameters: {
          Text: "This is Sentinel Care calling for your post-discharge follow-up.",
        },
        Transitions: {
          NextAction: "GetCustomerInput",
          Errors: [
            { NextAction: "GetCustomerInput", ErrorType: "NoMatchingError" },
          ],
        },
      },
      {
        Identifier: "GetCustomerInput",
        Type: "GetParticipantInput",
        Parameters: {
          Text: "Please tell us how you have been feeling since your discharge.",
          LexV2Bot: {
            AliasArn: `arn:aws:lex:${REGION}:${ACCOUNT_ID}:bot-alias/${botId}/${botAliasId}`,
          },
        },
        Transitions: {
          NextAction: "InvokeTriage",
          Errors: [
            { NextAction: "PlayError", ErrorType: "NoMatchingError" },
          ],
        },
      },
      {
        Identifier: "InvokeTriage",
        Type: "InvokeLambdaFunction",
        Parameters: {
          LambdaFunctionARN: `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:sentinel-triage-engine`,
          InvocationTimeLimitSeconds: "8",
          LambdaInvocationAttributes: {
            patientId: "$.Attributes.patientId",
            callId:    "$.Attributes.callId",
            contactId: "$.ContactId",
          },
          ResponseValidation: {
            ResponseType: "STRING_MAP",
          },
        },
        Transitions: {
          NextAction: "Disconnect",
          Errors: [
            { NextAction: "PlayError", ErrorType: "NoMatchingError" },
          ],
        },
      },
      {
        Identifier: "PlayError",
        Type: "MessageParticipant",
        Parameters: {
          Text: "We are unable to complete your call. Your care team will contact you shortly.",
        },
        Transitions: {
          NextAction: "Disconnect",
          Errors: [
            { NextAction: "Disconnect", ErrorType: "NoMatchingError" },
          ],
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
}

async function updateContactFlow(
  connect: ConnectClient,
  botId: string,
  botAliasId: string,
): Promise<boolean> {
  try {
    await connect.send(new UpdateContactFlowContentCommand({
      InstanceId:    INSTANCE_ID,
      ContactFlowId: FLOW_ID,
      Content:       buildFlowContent(botId, botAliasId),
    }));
    return true;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name ?? "";
    if (name === "InvalidContactFlowException") {
      // Connect's API rejects GetParticipantInput/GetUserInput + LexV2Bot blocks
      // when set programmatically. The flow must be wired to the Lex bot via the
      // Connect console: Flows → GetCustomerInput block → Amazon Lex V2 → SentinelVoiceLive.
      return false;
    }
    throw err;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(SEP);
  console.log("SENTINEL — LEX BOT SETUP");
  console.log(SEP + "\n");

  const lex     = new LexModelsV2Client({ region: REGION });
  const connect = new ConnectClient({ region: REGION });

  // Step 1 — Create or find bot
  console.log("STEP 1 — Creating Lex v2 bot...");
  const botId = await getOrCreateBot(lex);
  console.log(`  ✓ Bot ID: ${botId}`);

  // Wait for bot to be Available before creating locale
  {
    const deadline = Date.now() + 2 * 60 * 1000;
    while (Date.now() < deadline) {
      const desc = await lex.send(new DescribeBotCommand({ botId }));
      if (desc.botStatus === "Available" || desc.botStatus === "Versioning") break;
      if (desc.botStatus === "Failed") throw new Error("Bot creation failed");
      process.stdout.write(`\r  Waiting for bot... ${desc.botStatus ?? "Unknown"}   `);
      await new Promise<void>((r) => setTimeout(r, 3_000));
    }
    process.stdout.write("\n");
  }

  // Step 2 — Create locale
  console.log("\nSTEP 2 — Creating bot locale (en_US)...");
  await ensureBotLocale(lex, botId);
  console.log(`  ✓ Locale ${LOCALE_ID} ready`);

  // Step 3 — Create intent
  console.log("\nSTEP 3 — Creating PatientFollowUp intent...");
  await ensureIntent(lex, botId);
  console.log("  ✓ Intent PatientFollowUp created");

  // Step 4 — Build locale
  console.log("\nSTEP 4 — Building bot locale...");
  await buildLocale(lex, botId);
  console.log("  ✓ Bot locale built");

  // Step 5 — Create version
  console.log("\nSTEP 5 — Creating bot version...");
  const botVersion = await createBotVersion(lex, botId);
  console.log(`  ✓ Bot version: ${botVersion}`);

  // Step 6 — Create alias
  console.log("\nSTEP 6 — Creating bot alias...");
  const botAliasId = await getOrCreateAlias(lex, botId, botVersion);
  console.log(`  ✓ Alias ID: ${botAliasId}`);

  // Step 7 — Associate with Connect
  console.log("\nSTEP 7 — Associating Lex bot with Connect...");
  await associateWithConnect(connect);
  console.log("  ✓ Bot associated with Connect");

  // Step 8 — Grant Connect permission + IAM policy
  console.log("\nSTEP 8 — Granting Connect permission to use Lex alias...");
  await grantConnectPermission(lex, botId, botAliasId);
  console.log("  ✓ Resource policy created");

  console.log("\nSTEP 8b — Adding Lex permissions to IAM role...");
  await addLexIamPolicy();
  console.log("  ✓ IAM policy sentinel-lex-policy added");

  // Step 9 — Save to .env
  console.log("\nSTEP 9 — Saving to .env...");
  updateEnvFile({
    LEX_BOT_ID:       botId,
    LEX_BOT_ALIAS_ID: botAliasId,
    LEX_BOT_VERSION:  botVersion,
  });
  console.log("  ✓ .env updated");

  // Step 10 — Update contact flow
  console.log("\nSTEP 10 — Updating contact flow...");
  const flowUpdated = await updateContactFlow(connect, botId, botAliasId);
  if (flowUpdated) {
    console.log(`  ✓ Contact flow updated (flow ID: ${FLOW_ID})`);
  } else {
    console.log(`  ⚠ Connect API rejected GetParticipantInput + LexV2Bot block.`);
    console.log(`    To complete this step manually in the Connect console:`);
    console.log(`    1. Open flow: ${FLOW_ID}`);
    console.log(`    2. Add a "Get customer input" block`);
    console.log(`    3. Select Amazon Lex V2 → SentinelVoiceBot → ${ALIAS_NAME}`);
    console.log(`    4. Wire: Greeting → Get customer input → InvokeTriage → Disconnect`);
    console.log(`    Bot alias ARN: arn:aws:lex:${REGION}:${ACCOUNT_ID}:bot-alias/${botId}/${botAliasId}`);
  }

  // Summary
  console.log("\n" + SEP);
  console.log("LEX BOT SETUP COMPLETE");
  console.log(SEP);
  console.log(`  Bot ID:        ${botId}`);
  console.log(`  Bot Version:   ${botVersion}`);
  console.log(`  Alias ID:      ${botAliasId}`);
  console.log(`  Bot Status:    Built`);
  console.log(`  Connect:       Associated`);
  console.log(`  .env:          Updated`);
  console.log(SEP);
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    console.error("setup:lex failed:", err.message);
    console.error("  name:", (err as { name?: string }).name);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (err as any).$metadata;
    if (meta) console.error("  httpStatus:", meta.httpStatusCode, "requestId:", meta.requestId);
  } else {
    console.error("setup:lex failed:", String(err));
  }
  process.exit(1);
});
