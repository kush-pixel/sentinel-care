/**
 * rebuild-fhir.ts — Terminate the broken FHIR EC2 instance, launch a fresh
 * t3.small with HAPI FHIR running under systemd, update .env + all Lambda
 * environment variables, then re-seed patient data.
 *
 * Run: cd scripts && npm run rebuild:fhir
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import {
  EC2Client,
  TerminateInstancesCommand,
  RunInstancesCommand,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  LambdaClient,
  ListFunctionsCommand,
  GetFunctionConfigurationCommand,
  UpdateFunctionConfigurationCommand,
  InvokeCommand,
} from "@aws-sdk/client-lambda";
import { seedFhir }       from "../fhir/seed-fhir";
import { seedEncounters } from "../fhir/seed-encounters";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ─── Constants ────────────────────────────────────────────────────────────────

const REGION           = process.env["AWS_REGION"] ?? "us-east-1";
const OLD_INSTANCE_ID  = "i-0f4420d87956be2c5";
const AMI_ID           = "ami-05024c2628f651b80";
const INSTANCE_TYPE    = "t3.small";
const SUBNET_ID        = "subnet-0ca8bd0caf67822c6";
const SECURITY_GROUP   = "sg-059716faef0979c84";
const SEP              = "─────────────────────────────────────────────";
const ENV_PATH         = path.resolve(__dirname, "../../../.env");

// ─── UserData ─────────────────────────────────────────────────────────────────

const USER_DATA_SCRIPT = `#!/bin/bash
yum update -y
yum install -y docker
systemctl enable docker
systemctl start docker
cat > /etc/systemd/system/hapi-fhir.service << 'EOF'
[Unit]
Description=HAPI FHIR Server
After=docker.service
Requires=docker.service
[Service]
Restart=always
RestartSec=10
ExecStartPre=-/usr/bin/docker stop hapi-fhir
ExecStartPre=-/usr/bin/docker rm hapi-fhir
ExecStart=/usr/bin/docker run --name hapi-fhir \\
  -p 8080:8080 \\
  -e hapi.fhir.allow_multiple_delete=true \\
  -e hapi.fhir.fhir_version=R4 \\
  --memory=1500m \\
  hapiproject/hapi:latest
ExecStop=/usr/bin/docker stop hapi-fhir
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable hapi-fhir
systemctl start hapi-fhir
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGet(url: string, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.on("error",   () => resolve(0));
  });
}

// ─── Step 1 — Terminate old instance ─────────────────────────────────────────

async function terminateOld(ec2: EC2Client): Promise<void> {
  console.log(`  Terminating ${OLD_INSTANCE_ID}...`);
  try {
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [OLD_INSTANCE_ID] }));
    console.log(`  ✓ Termination request accepted`);
  } catch (err: unknown) {
    const code = (err as { name?: string }).name ?? "";
    if (code === "InvalidInstanceID.NotFound" || code === "InvalidInstanceID.Malformed") {
      console.log(`  (instance already gone — continuing)`);
    } else {
      console.log(`  Warning: terminate returned: ${(err as Error).message ?? String(err)}`);
      console.log(`  Continuing anyway...`);
    }
  }
  console.log(`  Waiting 30 s for termination to propagate...`);
  await delay(30_000);
}

// ─── Step 2 — Launch new instance ─────────────────────────────────────────────

async function launchNew(ec2: EC2Client): Promise<string> {
  console.log(`  Launching new ${INSTANCE_TYPE} (${AMI_ID})...`);

  const userData = Buffer.from(USER_DATA_SCRIPT).toString("base64");

  const resp = await ec2.send(new RunInstancesCommand({
    ImageId:          AMI_ID,
    InstanceType:     INSTANCE_TYPE as "t3.small",
    MinCount:         1,
    MaxCount:         1,
    SubnetId:         SUBNET_ID,
    SecurityGroupIds: [SECURITY_GROUP],
    UserData:         userData,
    TagSpecifications: [{
      ResourceType: "instance",
      Tags: [{ Key: "Name", Value: "sentinel-fhir-server" }],
    }],
  }));

  const instanceId = resp.Instances?.[0]?.InstanceId;
  if (!instanceId) throw new Error("RunInstances returned no InstanceId");

  console.log(`  ✓ Instance launched: ${instanceId}`);
  return instanceId;
}

// ─── Step 3 — Wait for running + public IP ───────────────────────────────────

async function waitForRunning(ec2: EC2Client, instanceId: string): Promise<string> {
  const timeoutMs = 3 * 60 * 1000;
  const start     = Date.now();

  console.log(`  Polling for running state (timeout 3 min)...`);

  while (Date.now() - start < timeoutMs) {
    await delay(10_000);

    const resp = await ec2.send(new DescribeInstancesCommand({
      InstanceIds: [instanceId],
    }));

    const inst = resp.Reservations?.[0]?.Instances?.[0];
    const state = inst?.State?.Name ?? "unknown";
    const ip    = inst?.PublicIpAddress;

    process.stdout.write(`  state=${state}...`);

    if (state === "running" && ip) {
      console.log(` IP=${ip}`);
      return ip;
    }

    if (state === "terminated" || state === "shutting-down") {
      throw new Error(`Instance entered unexpected state: ${state}`);
    }

    console.log(` (waiting)`);
  }

  throw new Error("Timed out waiting for instance to enter running state");
}

// ─── Step 4 — Wait for FHIR to respond ───────────────────────────────────────

async function waitForFhir(ip: string): Promise<void> {
  const url       = `http://${ip}:8080/fhir/metadata`;
  const timeoutMs = 8 * 60 * 1000;
  const start     = Date.now();

  console.log(`  Polling ${url} (timeout 8 min)...`);
  console.log(`  Note: t3.small + HAPI typically takes 4–6 minutes.`);

  while (Date.now() - start < timeoutMs) {
    await delay(15_000);

    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`  [${elapsed}s] GET /fhir/metadata...`);

    const status = await httpGet(url);
    if (status === 200) {
      console.log(` HTTP 200`);
      console.log(`  ✓ FHIR server ready at ${ip}`);
      return;
    }

    console.log(` HTTP ${status || "no response"} (waiting)`);
  }

  throw new Error("Timed out waiting for FHIR server to respond");
}

// ─── Step 5 — Update .env ─────────────────────────────────────────────────────

function updateEnv(ip: string): void {
  let content = fs.readFileSync(ENV_PATH, "utf8");

  // Replace any existing FHIR_BASE_URL line (commented or active)
  content = content.replace(
    /^#?\s*FHIR_BASE_URL=.*$/m,
    `FHIR_BASE_URL=http://${ip}:8080/fhir`,
  );

  // Also clear the commented-out old IP if present as a separate line
  content = content.replace(
    /^#\s*FHIR_BASE_URL=http:\/\/44\.\d+\.\d+\.\d+.*$/m,
    "",
  );

  fs.writeFileSync(ENV_PATH, content, "utf8");
  process.env["FHIR_BASE_URL"] = `http://${ip}:8080/fhir`;
  console.log(`  ✓ .env updated: FHIR_BASE_URL=http://${ip}:8080/fhir`);
}

// ─── Step 6 — Update all Lambda env vars ─────────────────────────────────────

async function updateLambdas(lambda: LambdaClient, ip: string): Promise<number> {
  const newFhirUrl = `http://${ip}:8080/fhir`;
  const functions: string[] = [];
  let marker: string | undefined;

  do {
    const resp = await lambda.send(new ListFunctionsCommand({ Marker: marker }));
    for (const fn of resp.Functions ?? []) {
      if (fn.FunctionName?.startsWith("sentinel")) {
        functions.push(fn.FunctionName);
      }
    }
    marker = resp.NextMarker;
  } while (marker);

  let updated = 0;

  for (const fnName of functions) {
    try {
      const cfg  = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fnName }));
      const vars = { ...(cfg.Environment?.Variables ?? {}), FHIR_BASE_URL: newFhirUrl };

      await lambda.send(new UpdateFunctionConfigurationCommand({
        FunctionName: fnName,
        Environment:  { Variables: vars },
      }));

      console.log(`  ✓ Updated ${fnName}`);
      updated++;
    } catch (err: unknown) {
      console.log(`  ✗ ${fnName}: ${(err as Error).message ?? String(err)}`);
    }
  }

  return updated;
}

// ─── Step 7 — Re-seed FHIR data ──────────────────────────────────────────────

async function reseed(): Promise<void> {
  await seedFhir();
  console.log("  ✓ FHIR patients re-seeded");

  await seedEncounters();
  console.log("  ✓ FHIR encounters re-seeded");
}

// ─── Step 8 — Verify care planner ────────────────────────────────────────────

async function verifyCare(lambda: LambdaClient): Promise<boolean> {
  try {
    const resp = await lambda.send(new InvokeCommand({
      FunctionName: "sentinel-care-planner",
      Payload:      Buffer.from(JSON.stringify({ patientId: "P001" })),
    }));
    const body = resp.Payload
      ? JSON.parse(Buffer.from(resp.Payload).toString()) as { statusCode?: number }
      : {};
    return body.statusCode === 200;
  } catch {
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(SEP);
  console.log("SENTINEL — FHIR SERVER REBUILD");
  console.log(SEP + "\n");

  const ec2    = new EC2Client({ region: REGION });
  const lambda = new LambdaClient({ region: REGION });

  // Step 1
  console.log("STEP 1 — Terminating old instance...");
  await terminateOld(ec2);

  // Step 2
  console.log("\nSTEP 2 — Launching new instance...");
  const instanceId = await launchNew(ec2);

  // Step 3
  console.log("\nSTEP 3 — Waiting for instance to be running...");
  const ip = await waitForRunning(ec2, instanceId);
  console.log(`  ✓ Instance running: ${instanceId} (${ip})`);

  // Step 4
  console.log("\nSTEP 4 — Waiting for FHIR to respond on port 8080...");
  await waitForFhir(ip);

  // Step 5
  console.log("\nSTEP 5 — Updating .env...");
  updateEnv(ip);

  // Step 6
  console.log("\nSTEP 6 — Updating Lambda environment variables...");
  const lambdaCount = await updateLambdas(lambda, ip);

  // Step 7
  console.log("\nSTEP 7 — Re-seeding FHIR data...");
  await reseed();

  // Step 8
  console.log("\nSTEP 8 — Verifying care planner Lambda...");
  const carePlannerOk = await verifyCare(lambda);
  console.log(`  ${carePlannerOk ? "✓" : "✗"} sentinel-care-planner: ${carePlannerOk ? "PASS" : "FAIL"}`);

  // Step 9 — Summary
  console.log("\n" + SEP);
  console.log("FHIR SERVER REBUILT");
  console.log(SEP);
  console.log(`  Old instance:    terminated   (${OLD_INSTANCE_ID})`);
  console.log(`  New instance:    ${instanceId}`);
  console.log(`  New IP:          ${ip}`);
  console.log(`  FHIR status:     UP`);
  console.log(`  .env updated:    ✓`);
  console.log(`  Lambdas updated: ${lambdaCount}/9`);
  console.log(`  Data re-seeded:  ✓`);
  console.log(`  Care planner:    ${carePlannerOk ? "PASS" : "FAIL"}`);
  console.log(SEP);

  if (!carePlannerOk) {
    console.log("\n  WARNING: Care planner returned non-200. Check Lambda logs.");
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    console.error("\nrebuild:fhir failed:", err.message);
    const meta = (err as { $metadata?: { httpStatusCode?: number; requestId?: string } }).$metadata;
    if (meta) console.error("  httpStatus:", meta.httpStatusCode, "requestId:", meta.requestId);
  } else {
    console.error("\nrebuild:fhir failed:", String(err));
  }
  process.exit(1);
});
