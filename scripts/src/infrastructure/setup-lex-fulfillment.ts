/**
 * setup-lex-fulfillment.ts — Wire sentinel-lex-fulfillment Lambda into the
 * SentinelVoiceBot as a dialog code hook so it drives every conversation turn.
 *
 * Steps:
 *   1. Add Lambda invoke permission for lexv2.amazonaws.com
 *   2. Update bot alias to point Lambda ARN at the code hook
 *   3. Enable dialogCodeHook on the PatientFollowUp intent
 *   4. Rebuild bot locale
 *   5. Create new bot version
 *   6. Update alias to new version
 *
 * Run: cd scripts && npm run setup:lex-fulfillment
 */

import * as dotenv from "dotenv";
import * as path   from "path";
import {
  LexModelsV2Client,
  ListIntentsCommand,
  DescribeIntentCommand,
  UpdateIntentCommand,
  UpdateBotAliasCommand,
  BuildBotLocaleCommand,
  DescribeBotLocaleCommand,
  CreateBotVersionCommand,
  DescribeBotVersionCommand,
  ListSlotsCommand,
  CreateSlotCommand,
  UpdateSlotCommand,
  ListSlotTypesCommand,
} from "@aws-sdk/client-lex-models-v2";
import {
  LambdaClient,
  AddPermissionCommand,
} from "@aws-sdk/client-lambda";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ─── Constants ────────────────────────────────────────────────────────────────

const REGION        = process.env["AWS_REGION"] ?? "us-east-1";
const ACCOUNT_ID    = "629843009128";
const BOT_ID        = process.env["LEX_BOT_ID"]       ?? "KEVYFJMTZ5";
const BOT_ALIAS_ID  = process.env["LEX_BOT_ALIAS_ID"] ?? "YOH9BNHFPG";
const ALIAS_NAME    = "SentinelVoiceLive";
const LOCALE_ID     = "en_US";
const INTENT_NAME   = "PatientFollowUp";
const LAMBDA_NAME   = "sentinel-lex-fulfillment";
const LAMBDA_ARN    = `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}`;
const SEP           = "─────────────────────────────────────────────";

// ─── Step 1 — Add Lambda invoke permission ────────────────────────────────────

async function addLambdaPermission(lambda: LambdaClient): Promise<void> {
  try {
    await lambda.send(new AddPermissionCommand({
      FunctionName: LAMBDA_NAME,
      StatementId:  "lex-invoke-sentinel",
      Action:       "lambda:InvokeFunction",
      Principal:    "lexv2.amazonaws.com",
      SourceAccount: ACCOUNT_ID,
      SourceArn:    `arn:aws:lex:${REGION}:${ACCOUNT_ID}:bot-alias/${BOT_ID}/${BOT_ALIAS_ID}`,
    }));
    console.log("  ✓ Lambda permission added for lexv2.amazonaws.com");
  } catch (err: unknown) {
    const name = (err as { name?: string }).name ?? "";
    if (name === "ResourceConflictException") {
      console.log("  (Lambda permission already exists)");
    } else {
      throw err;
    }
  }
}

// ─── Step 2 — Update bot alias with Lambda code hook ─────────────────────────

async function updateAliasCodeHook(lex: LexModelsV2Client): Promise<void> {
  await lex.send(new UpdateBotAliasCommand({
    botId:         BOT_ID,
    botAliasId:    BOT_ALIAS_ID,
    botAliasName:  ALIAS_NAME,
    // Keep pointing to same bot version — new version created in Step 5
    botVersion:    process.env["LEX_BOT_VERSION"] ?? "1",
    botAliasLocaleSettings: {
      [LOCALE_ID]: {
        enabled: true,
        codeHookSpecification: {
          lambdaCodeHook: {
            lambdaARN:                LAMBDA_ARN,
            codeHookInterfaceVersion: "1.0",
          },
        },
      },
    },
    sentimentAnalysisSettings: { detectSentiment: false },
  }));
  console.log(`  ✓ Alias ${ALIAS_NAME} updated with Lambda code hook`);
  console.log(`    Lambda: ${LAMBDA_ARN}`);
}

// ─── Step 3 — Enable dialogCodeHook on PatientFollowUp intent ────────────────

async function enableDialogCodeHook(lex: LexModelsV2Client): Promise<void> {
  // Find the PatientFollowUp intent
  let intentId: string | undefined;
  let nextToken: string | undefined;

  do {
    const list = await lex.send(new ListIntentsCommand({
      botId:      BOT_ID,
      botVersion: "DRAFT",
      localeId:   LOCALE_ID,
      ...(nextToken && { nextToken }),
    }));
    const found = (list.intentSummaries ?? []).find(
      (i) => i.intentName === INTENT_NAME,
    );
    if (found?.intentId) {
      intentId = found.intentId;
      break;
    }
    nextToken = list.nextToken;
  } while (nextToken);

  if (!intentId) throw new Error(`Intent "${INTENT_NAME}" not found in bot ${BOT_ID}`);
  console.log(`  Found ${INTENT_NAME} — intentId: ${intentId}`);

  // Get the full current intent definition
  const desc = await lex.send(new DescribeIntentCommand({
    botId:      BOT_ID,
    botVersion: "DRAFT",
    localeId:   LOCALE_ID,
    intentId,
  }));

  // Update with dialog code hook enabled (preserving all existing fields)
  await lex.send(new UpdateIntentCommand({
    botId:            BOT_ID,
    botVersion:       "DRAFT",
    localeId:         LOCALE_ID,
    intentId,
    intentName:       INTENT_NAME,
    description:      desc.description,
    sampleUtterances: desc.sampleUtterances,
    // Enable dialog code hook — Lambda will be called on every turn
    dialogCodeHook:   { enabled: true },
    // Fulfillment code hook not needed — Lambda returns Close directly
    fulfillmentCodeHook: {
      enabled: false,
      postFulfillmentStatusSpecification: {},
    },
  }));

  console.log(`  ✓ dialogCodeHook enabled on ${INTENT_NAME}`);
}

// ─── Step 3b — Enable dialogCodeHook on FallbackIntent ───────────────────────
// FallbackIntent fires when the patient says anything that doesn't match
// PatientFollowUp utterances (e.g., "Hello", free-form answers).
// With dialogCodeHook enabled, the Lambda is called on every FallbackIntent
// turn, keeping the conversation alive via ElicitIntent responses.

async function enableFallbackCodeHook(lex: LexModelsV2Client): Promise<void> {
  await lex.send(new UpdateIntentCommand({
    botId:          BOT_ID,
    botVersion:     "DRAFT",
    localeId:       LOCALE_ID,
    intentId:       "FALLBCKINT",
    intentName:     "FallbackIntent",
    parentIntentSignature: "AMAZON.FallbackIntent",
    dialogCodeHook: { enabled: true },
  }));
  console.log("  ✓ dialogCodeHook enabled on FallbackIntent");
}

// ─── Step 4 — Rebuild bot locale ─────────────────────────────────────────────

async function rebuildLocale(lex: LexModelsV2Client): Promise<void> {
  try {
    await lex.send(new BuildBotLocaleCommand({
      botId:      BOT_ID,
      botVersion: "DRAFT",
      localeId:   LOCALE_ID,
    }));
  } catch (err: unknown) {
    const name = (err as { name?: string }).name ?? "";
    const msg  = (err as { message?: string }).message ?? "";
    if (name !== "ConflictException" && !msg.includes("already")) throw err;
  }

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const desc = await lex.send(new DescribeBotLocaleCommand({
      botId:      BOT_ID,
      botVersion: "DRAFT",
      localeId:   LOCALE_ID,
    }));
    const status = desc.botLocaleStatus ?? "Unknown";
    process.stdout.write(`\r  Building locale... ${status}         `);
    if (status === "Built") {
      process.stdout.write("\n");
      return;
    }
    if (status === "Failed") {
      const reasons = (desc.failureReasons ?? []).join("; ");
      throw new Error(`Bot locale build failed: ${reasons}`);
    }
    await new Promise<void>((r) => setTimeout(r, 8_000));
  }
  throw new Error("Timed out waiting for bot locale to build");
}

// ─── Step 5 — Create new bot version ─────────────────────────────────────────

async function createNewVersion(lex: LexModelsV2Client): Promise<string> {
  const resp = await lex.send(new CreateBotVersionCommand({
    botId: BOT_ID,
    botVersionLocaleSpecification: {
      [LOCALE_ID]: { sourceBotVersion: "DRAFT" },
    },
  }));

  const botVersion = resp.botVersion;
  if (!botVersion) throw new Error("CreateBotVersion returned no botVersion");

  const deadline = Date.now() + 5 * 60 * 1000;
  let   retries  = 0;

  while (Date.now() < deadline) {
    try {
      const desc = await lex.send(new DescribeBotVersionCommand({ botId: BOT_ID, botVersion }));
      retries = 0;
      const status = desc.botStatus ?? "Unknown";
      process.stdout.write(`\r  Waiting for version ${botVersion}... ${status}   `);
      if (status === "Available") {
        process.stdout.write("\n");
        return botVersion;
      }
      if (status === "Failed") {
        throw new Error(`Bot version ${botVersion} failed to create`);
      }
    } catch (err: unknown) {
      const name = (err as { name?: string }).name ?? "";
      if (
        (name === "ResourceNotFoundException" || name === "AccessDeniedException") &&
        retries < 6
      ) {
        retries++;
        process.stdout.write(`\r  Version propagating (${retries}/6)...        `);
      } else {
        throw err;
      }
    }
    await new Promise<void>((r) => setTimeout(r, 5_000));
  }
  throw new Error("Timed out waiting for bot version");
}

// ─── Step 6 — Point alias to new version ─────────────────────────────────────

async function updateAliasVersion(lex: LexModelsV2Client, botVersion: string): Promise<void> {
  await lex.send(new UpdateBotAliasCommand({
    botId:         BOT_ID,
    botAliasId:    BOT_ALIAS_ID,
    botAliasName:  ALIAS_NAME,
    botVersion,
    botAliasLocaleSettings: {
      [LOCALE_ID]: {
        enabled: true,
        codeHookSpecification: {
          lambdaCodeHook: {
            lambdaARN:                LAMBDA_ARN,
            codeHookInterfaceVersion: "1.0",
          },
        },
      },
    },
    sentimentAnalysisSettings: { detectSentiment: false },
  }));
  console.log(`  ✓ Alias ${ALIAS_NAME} updated to version ${botVersion}`);
}

// ─── Step 3c — Create/update 'answer' slot with reduced audio timeouts ───────
// startTimeoutMs: 2500 — give patients enough time to process the question and start
//                        speaking; 1000ms is too short and causes Lex to time out
//                        before the patient begins, resulting in blank transcripts
//                        and skipped questions on outbound calls.
// endTimeoutMs:   2000 — patient responses are short; cut off silence quickly

async function ensureAnswerSlotWithTimeout(lex: LexModelsV2Client): Promise<void> {
  // Resolve PatientFollowUp intentId
  let intentId: string | undefined;
  let intentToken: string | undefined;
  do {
    const list = await lex.send(new ListIntentsCommand({
      botId: BOT_ID, botVersion: "DRAFT", localeId: LOCALE_ID,
      ...(intentToken && { nextToken: intentToken }),
    }));
    const found = (list.intentSummaries ?? []).find(i => i.intentName === INTENT_NAME);
    if (found?.intentId) { intentId = found.intentId; break; }
    intentToken = list.nextToken;
  } while (intentToken);
  if (!intentId) throw new Error(`Intent "${INTENT_NAME}" not found`);

  // Resolve AMAZON.FreeFormInput slot type ID
  let freeFormSlotTypeId: string | undefined;
  let nextToken: string | undefined;
  do {
    const stList = await lex.send(new ListSlotTypesCommand({
      botId: BOT_ID, botVersion: "DRAFT", localeId: LOCALE_ID,
      ...(nextToken && { nextToken }),
    }));
    const found = (stList.slotTypeSummaries ?? []).find(
      st => st.slotTypeName === "AMAZON.FreeFormInput",
    );
    if (found?.slotTypeId) { freeFormSlotTypeId = found.slotTypeId; break; }
    nextToken = stList.nextToken;
  } while (nextToken);

  // The built-in AMAZON.FreeFormInput has a fixed ARN used as slotTypeId in Lex v2
  const slotTypeId = freeFormSlotTypeId ?? "AMAZON.FreeFormInput";

  const elicitationSetting = {
    slotConstraint: "Optional" as const,
    promptSpecification: {
      messageGroups: [{
        message: { plainTextMessage: { value: "Please respond." } },
      }],
      maxRetries:       2,
      allowInterrupt:   true,
      promptAttemptsSpecification: {
        Initial: {
          allowInterrupt:    true,
          allowedInputTypes: { allowAudioInput: true, allowDTMFInput: false },
          audioAndDTMFInputSpecification: {
            startTimeoutMs: 2500,
            audioSpecification: { endTimeoutMs: 2000, maxLengthMs: 15000 },
          },
        },
        Retry1: {
          allowInterrupt:    true,
          allowedInputTypes: { allowAudioInput: true, allowDTMFInput: false },
          audioAndDTMFInputSpecification: {
            startTimeoutMs: 2500,
            audioSpecification: { endTimeoutMs: 2000, maxLengthMs: 15000 },
          },
        },
      },
    },
  };

  // Check if 'answer' slot already exists
  const slotList = await lex.send(new ListSlotsCommand({
    botId: BOT_ID, botVersion: "DRAFT", localeId: LOCALE_ID, intentId,
  }));
  const existingSlot = (slotList.slotSummaries ?? []).find(s => s.slotName === "answer");

  let slotId: string;
  if (existingSlot?.slotId) {
    await lex.send(new UpdateSlotCommand({
      botId: BOT_ID, botVersion: "DRAFT", localeId: LOCALE_ID,
      intentId, slotId: existingSlot.slotId,
      slotName:                "answer",
      slotTypeId,
      valueElicitationSetting: elicitationSetting,
    }));
    slotId = existingSlot.slotId;
    console.log("  ✓ 'answer' slot updated — startTimeoutMs: 2500, endTimeoutMs: 2000");
  } else {
    const created = await lex.send(new CreateSlotCommand({
      botId: BOT_ID, botVersion: "DRAFT", localeId: LOCALE_ID,
      intentId,
      slotName:                "answer",
      slotTypeId,
      valueElicitationSetting: elicitationSetting,
    }));
    if (!created.slotId) throw new Error("CreateSlot returned no slotId");
    slotId = created.slotId;
    console.log("  ✓ 'answer' slot created — startTimeoutMs: 2500, endTimeoutMs: 2000");
  }

  // Lex requires every slot to have a declared priority on the intent — set priority 1
  const intentDesc = await lex.send(new DescribeIntentCommand({
    botId: BOT_ID, botVersion: "DRAFT", localeId: LOCALE_ID, intentId,
  }));
  await lex.send(new UpdateIntentCommand({
    botId:            BOT_ID,
    botVersion:       "DRAFT",
    localeId:         LOCALE_ID,
    intentId,
    intentName:       INTENT_NAME,
    description:      intentDesc.description,
    sampleUtterances: intentDesc.sampleUtterances,
    dialogCodeHook:   { enabled: true },
    fulfillmentCodeHook: { enabled: false, postFulfillmentStatusSpecification: {} },
    slotPriorities:   [{ priority: 1, slotId }],
  }));
  console.log("  ✓ Intent slot priorities set");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(SEP);
  console.log("SENTINEL — LEX FULFILLMENT SETUP");
  console.log(SEP + "\n");
  console.log(`  Bot ID:      ${BOT_ID}`);
  console.log(`  Alias ID:    ${BOT_ALIAS_ID}`);
  console.log(`  Lambda:      ${LAMBDA_ARN}\n`);

  const lex    = new LexModelsV2Client({ region: REGION });
  const lambda = new LambdaClient({ region: REGION });

  // Step 1 — Lambda permission
  console.log("STEP 1 — Adding Lambda invoke permission...");
  await addLambdaPermission(lambda);

  // Step 2 — Update alias with Lambda
  console.log("\nSTEP 2 — Updating bot alias with dialog code hook...");
  await updateAliasCodeHook(lex);

  // Step 3 — Enable dialog code hook on intent
  console.log("\nSTEP 3 — Enabling dialogCodeHook on PatientFollowUp intent...");
  await enableDialogCodeHook(lex);

  // Step 3b — Enable dialog code hook on FallbackIntent
  console.log("\nSTEP 3b — Enabling dialogCodeHook on FallbackIntent...");
  await enableFallbackCodeHook(lex);

  // Step 3c — Create/update 'answer' slot with 1s/2.5s audio timeouts (reduced from 6s default)
  console.log("\nSTEP 3c — Configuring 'answer' slot audio timeouts...");
  await ensureAnswerSlotWithTimeout(lex);

  // Step 4 — Rebuild locale
  console.log("\nSTEP 4 — Rebuilding bot locale...");
  await rebuildLocale(lex);
  console.log("  ✓ Bot locale rebuilt");

  // Step 5 — New version
  console.log("\nSTEP 5 — Creating new bot version...");
  const botVersion = await createNewVersion(lex);
  console.log(`  ✓ New version: ${botVersion}`);

  // Step 6 — Update alias to new version
  console.log("\nSTEP 6 — Pointing alias to new version...");
  await updateAliasVersion(lex, botVersion);

  // Summary
  console.log("\n" + SEP);
  console.log("LEX FULFILLMENT SETUP COMPLETE");
  console.log(SEP);
  console.log(`  Bot ID:        ${BOT_ID}`);
  console.log(`  Alias ID:      ${BOT_ALIAS_ID}`);
  console.log(`  Bot Version:   ${botVersion}`);
  console.log(`  Lambda:        ${LAMBDA_ARN}`);
  console.log(`  Code hook:     dialogCodeHook ENABLED on ${INTENT_NAME}`);
  console.log(SEP);
  console.log("\nNOTE — Manual Connect console step required:");
  console.log("  In the 'Get customer input' block, ensure session attributes");
  console.log("  are passed to Lex:");
  console.log("    patientId → $.Attributes.patientId");
  console.log("    callId    → $.Attributes.callId");
  console.log("  This passes the patient context to the fulfillment Lambda.");
  console.log(SEP);
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    console.error("\nsetup:lex-fulfillment failed:", err.message);
    console.error("  name:", (err as { name?: string }).name);
    const meta = (err as { $metadata?: { httpStatusCode?: number; requestId?: string } }).$metadata;
    if (meta) console.error("  httpStatus:", meta.httpStatusCode, "requestId:", meta.requestId);
  } else {
    console.error("\nsetup:lex-fulfillment failed:", String(err));
  }
  process.exit(1);
});
