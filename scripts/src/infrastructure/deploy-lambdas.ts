/**
 * deploy-lambdas.ts — Build and deploy all Lambda functions to AWS.
 *
 * Uses esbuild to bundle each Lambda into a single dist/handler.js,
 * then creates or updates the AWS Lambda function with full env vars.
 *
 * Run: cd scripts && npm run deploy:lambdas
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as esbuild from "esbuild";
import archiver from "archiver";
import {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  CreateFunctionUrlConfigCommand,
  GetFunctionUrlConfigCommand,
  AddPermissionCommand,
} from "@aws-sdk/client-lambda";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ─── Constants ────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "../../..");
const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const ROLE_ARN = "arn:aws:iam::629843009128:role/sentinel-lambda-role";
const SEP = "─────────────────────────────────────────────";

// ─── Lambda Definitions ───────────────────────────────────────────────────────

interface LambdaDef {
  name:            string;
  dir:             string;
  envKey:          string;
  timeout?:        number;
  memory?:         number;
  withFunctionUrl?: boolean;
}

const LAMBDAS: LambdaDef[] = [
  { name: "sentinel-care-planner",     dir: "lambdas/care-planner",     envKey: "LAMBDA_ARN_CARE_PLANNER"     },
  { name: "sentinel-summarizer",       dir: "lambdas/summarizer",       envKey: "LAMBDA_ARN_SUMMARIZER"       },
  { name: "sentinel-extractor",        dir: "lambdas/extractor",        envKey: "LAMBDA_ARN_EXTRACTOR"        },
  { name: "sentinel-call-initiator",   dir: "lambdas/call-initiator",   envKey: "LAMBDA_ARN_CALL_INITIATOR"   },
  { name: "sentinel-answer-collector", dir: "lambdas/answer-collector", envKey: "LAMBDA_ARN_ANSWER_COLLECTOR" },
  { name: "sentinel-call-complete",    dir: "lambdas/call-complete",    envKey: "LAMBDA_ARN_CALL_COMPLETE"    },
  { name: "sentinel-nova-sonic",       dir: "lambdas/nova-sonic-handler", envKey: "LAMBDA_ARN_NOVA_SONIC"     },
  { name: "sentinel-triage-engine",    dir: "packages/triage-engine",   envKey: "LAMBDA_ARN_TRIAGE_ENGINE"    },
  { name: "sentinel-call-bridge",     dir: "lambdas/call-bridge",     envKey: "LAMBDA_ARN_CALL_BRIDGE",     timeout: 10, memory: 256 },
  { name: "sentinel-lex-fulfillment", dir: "lambdas/lex-fulfillment", envKey: "LAMBDA_ARN_LEX_FULFILLMENT", timeout: 30, memory: 256 },
  { name: "sentinel-fhir-mock",       dir: "lambdas/fhir-mock",       envKey: "LAMBDA_ARN_FHIR_MOCK",       timeout: 10, memory: 256, withFunctionUrl: true },
];

// ─── Environment Variables ─────────────────────────────────────────────────────

const ENV_VARS: Record<string, string> = {

  FHIR_BASE_URL: process.env["FHIR_BASE_URL"] ?? "http://44.198.181.68:8080/fhir",
  DYNAMO_TABLE_PATIENTS: "PatientProfiles",
  DYNAMO_TABLE_PROTOCOLS: "TriageProtocols",
  DYNAMO_TABLE_RESULTS: "CallResults",
  DYNAMO_TABLE_RULES: "ClinicalRules",
  DYNAMO_TABLE_REVIEWS: "ProtocolReview",
  ESCALATION_TOPIC_ARN: "arn:aws:sns:us-east-1:629843009128:sentinel-red-escalation",
  CONFIDENCE_THRESHOLD: "0.7",
  BEDROCK_MODEL_CARE_PLANNER: "amazon.nova-pro-v1:0",
  BEDROCK_MODEL_EXTRACTOR: "amazon.nova-lite-v1:0",
  BEDROCK_MODEL_SUMMARIZER: "amazon.nova-lite-v1:0",
  BEDROCK_MODEL_VOICE: "amazon.nova-2-sonic-v1:0",
  CONNECT_INSTANCE_ID: "40725174-b7f7-4388-8ea4-e761fd3c18fe",
  CONNECT_QUEUE_ID: "be4bc249-5c71-4a27-8f15-83a565f6169c",
  CONNECT_PHONE_NUMBER: "+17208446427",
  KVS_STREAM_NAME: "sentinel-voice-calls",
  S3_BUCKET: "sentinel-audio-629843009128",
  POLLY_ENABLED: "false",
  NOVA_SONIC_TURN_TAKING: "MEDIUM",
  NOVA_SONIC_MAX_TOKENS: "4096",
  NOVA_SONIC_TEMPERATURE: "0.3",
  LAMBDA_ARN_NOVA_SONIC:      "arn:aws:lambda:us-east-1:629843009128:function:sentinel-nova-sonic",
  LAMBDA_ARN_TRIAGE_ENGINE:   "arn:aws:lambda:us-east-1:629843009128:function:sentinel-triage-engine",
  LAMBDA_ARN_SUMMARIZER:      "arn:aws:lambda:us-east-1:629843009128:function:sentinel-summarizer",
  KVS_STREAM_ARN:             process.env["KVS_STREAM_ARN"]           ?? "",
  CONNECT_CONTACT_FLOW_ID:    process.env["CONNECT_CONTACT_FLOW_ID"]  ?? "",
};

// ─── Step 1: Build ────────────────────────────────────────────────────────────

async function build(lambdaDir: string, name: string): Promise<void> {
  console.log(`  Building ${name}...`);
  fs.mkdirSync(path.join(lambdaDir, "dist"), { recursive: true });

  const result = await esbuild.build({
    entryPoints: [path.join(lambdaDir, "src", "handler.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    outfile: path.join(lambdaDir, "dist", "handler.js"),
    absWorkingDir: lambdaDir,
    logLevel: "silent",
  });

  if (result.errors.length > 0) {
    throw new Error(`esbuild failed for ${name}: ${result.errors.map((e) => e.text).join(", ")}`);
  }
}

// ─── Step 2: Package ──────────────────────────────────────────────────────────

async function createZip(lambdaDir: string, name: string): Promise<Buffer> {
  const handlerPath = path.join(lambdaDir, "dist", "handler.js");
  const zipPath = path.join(os.tmpdir(), `${name}.zip`);
  const output = fs.createWriteStream(zipPath);
  const arc = archiver("zip", { zlib: { level: 6 } });

  await new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    arc.on("error", (err: Error) => reject(err));
    arc.pipe(output);
    arc.file(handlerPath, { name: "dist/handler.js" });
    arc.finalize().catch(reject);
  });

  const buf = fs.readFileSync(zipPath);
  fs.unlinkSync(zipPath);
  return buf;
}

// ─── Step 3: Wait for Lambda to be ready ─────────────────────────────────────

async function waitForLambdaReady(client: LambdaClient, name: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const resp = await client.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
    if (resp.LastUpdateStatus !== "InProgress" && resp.State !== "Pending") return;
    await new Promise<void>((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for ${name} to become ready`);
}

// ─── Step 3b: Ensure Function URL exists (AuthType: NONE) ────────────────────

async function ensureFunctionUrl(client: LambdaClient, name: string): Promise<string> {
  // Check if URL already exists
  try {
    const existing = await client.send(new GetFunctionUrlConfigCommand({ FunctionName: name }));
    if (existing.FunctionUrl) {
      console.log(`    Function URL already exists: ${existing.FunctionUrl}`);
      return existing.FunctionUrl;
    }
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== "ResourceNotFoundException") throw err;
  }

  // Create URL with no auth
  const created = await client.send(
    new CreateFunctionUrlConfigCommand({ FunctionName: name, AuthType: "NONE" })
  );

  // Allow public invocation
  await client.send(
    new AddPermissionCommand({
      FunctionName: name,
      StatementId:  "AllowPublicFunctionUrl",
      Action:       "lambda:InvokeFunctionUrl",
      Principal:    "*",
      FunctionUrlAuthType: "NONE",
    })
  );

  const url = created.FunctionUrl ?? "";
  console.log(`    Function URL created: ${url}`);
  return url;
}

// ─── Step 4: Deploy Lambda ────────────────────────────────────────────────────

async function deployLambda(client: LambdaClient, def: LambdaDef): Promise<{ arn: string; functionUrl?: string }> {
  const lambdaDir = path.join(ROOT, def.dir);

  // Build
  await build(lambdaDir, def.name);
  const bundleBytes = fs.statSync(path.join(lambdaDir, "dist", "handler.js")).size;

  // Package
  console.log(`  Packaging ${def.name}...`);
  const zipBuffer = await createZip(lambdaDir, def.name);

  // Check if function exists
  let functionArn = `arn:aws:lambda:${REGION}:629843009128:function:${def.name}`;
  let exists = false;

  try {
    const info = await client.send(new GetFunctionCommand({ FunctionName: def.name }));
    exists = true;
    if (info.Configuration?.FunctionArn) {
      functionArn = info.Configuration.FunctionArn;
    }
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== "ResourceNotFoundException") throw err;
  }

  if (exists) {
    // Update code
    console.log(`  Updating ${def.name}...`);
    await client.send(new UpdateFunctionCodeCommand({
      FunctionName: def.name,
      ZipFile: zipBuffer,
    }));

    // Wait for update to complete before changing config
    await waitForLambdaReady(client, def.name);

    // Update config + env
    const cfg = await client.send(new UpdateFunctionConfigurationCommand({
      FunctionName: def.name,
      Handler: "dist/handler.handler",
      Timeout:    def.timeout ?? 300,
      MemorySize: def.memory  ?? 512,
      Environment: { Variables: ENV_VARS },
    }));
    if (cfg.FunctionArn) {
      functionArn = cfg.FunctionArn;
    }
  } else {
    // Create new function
    console.log(`  Creating ${def.name}...`);
    const created = await client.send(new CreateFunctionCommand({
      FunctionName: def.name,
      Runtime: "nodejs20.x",
      Role: ROLE_ARN,
      Handler: "dist/handler.handler",
      Code: { ZipFile: zipBuffer },
      Timeout:    def.timeout ?? 300,
      MemorySize: def.memory  ?? 512,
      Environment: { Variables: ENV_VARS },
    }));
    if (created.FunctionArn) {
      functionArn = created.FunctionArn;
    }
  }

  const bundleKB = (bundleBytes / 1024).toFixed(1);
  const zipKB = (zipBuffer.length / 1024).toFixed(1);
  console.log(`  ✓ ${def.name} deployed`);
  console.log(`    Bundle: ${bundleKB} KB → Zip: ${zipKB} KB`);
  console.log(`    ARN:    ${functionArn}`);

  // Optionally attach a public Function URL
  if (def.withFunctionUrl) {
    const functionUrl = await ensureFunctionUrl(client, def.name);
    return { arn: functionArn, functionUrl };
  }

  return { arn: functionArn };
}

// ─── Save ARNs to .env ────────────────────────────────────────────────────────

function updateEnvFile(arns: Record<string, string>): void {
  const envPath = path.join(ROOT, ".env");
  let content = fs.readFileSync(envPath, "utf8");

  for (const [key, value] of Object.entries(arns)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }

  fs.writeFileSync(envPath, content, "utf8");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(SEP);
  console.log("SENTINEL — LAMBDA DEPLOYMENT");
  console.log(SEP + "\n");

  const client = new LambdaClient({ region: REGION });
  const results: { def: LambdaDef; arn: string; functionUrl?: string }[] = [];

  for (const def of LAMBDAS) {
    console.log(`\n[${def.name}]`);
    const result = await deployLambda(client, def);
    results.push({ def, arn: result.arn, ...(result.functionUrl !== undefined ? { functionUrl: result.functionUrl } : {}) });
  }

  // Save ARNs (and Function URLs) to .env
  console.log("\nSaving ARNs to .env...");
  const arnMap: Record<string, string> = {};
  for (const { def, arn, functionUrl } of results) {
    arnMap[def.envKey] = arn;
    // If a Function URL was created, write it as FHIR_BASE_URL (strip trailing slash + add /fhir suffix)
    if (functionUrl !== undefined) {
      const base = functionUrl.replace(/\/$/, "");
      arnMap["FHIR_BASE_URL"] = `${base}/fhir`;
      console.log(`  ✓ FHIR_BASE_URL set to Lambda Function URL: ${base}/fhir`);
    }
  }
  updateEnvFile(arnMap);
  console.log("  ✓ .env updated");

  // Summary
  console.log("\n" + SEP);
  console.log("LAMBDA DEPLOYMENT COMPLETE");
  console.log(SEP);
  for (const { def, arn, functionUrl } of results) {
    console.log(`  ${def.name.padEnd(29)} ✓ ${arn}`);
    if (functionUrl !== undefined) {
      console.log(`  ${"  Function URL:".padEnd(29)}   ${functionUrl}`);
    }
  }
  console.log(SEP);
  console.log("All ARNs saved to .env automatically");
  console.log(SEP);
}

main().catch((err: unknown) => {
  console.error("deploy:lambdas failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
