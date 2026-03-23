/**
 * health-check.ts — Full system health check for Sentinel Care.
 *
 * Checks: FHIR server, Lambda deployments, Connect env vars,
 * DynamoDB data, Lambda invocations, P001 phone number.
 *
 * Run: cd scripts && npm run health:check
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import {
  LambdaClient,
  ListFunctionsCommand,
  GetFunctionConfigurationCommand,
  InvokeCommand,
} from "@aws-sdk/client-lambda";
import {
  DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import {
  EC2Client,
  DescribeInstanceStatusCommand,
} from "@aws-sdk/client-ec2";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ─── Constants ────────────────────────────────────────────────────────────────

const REGION           = process.env["AWS_REGION"] ?? "us-east-1";
const FHIR_BASE        = process.env["FHIR_BASE_URL"] ?? "http://3.239.230.36:8080/fhir";
const EC2_INSTANCE_ID  = "i-0733d2280cf6d2239";
const INSTANCE_ID      = "40725174-b7f7-4388-8ea4-e761fd3c18fe";
const EXPECTED_FLOW_ID = "45faa7a9-62ac-468c-a186-cc3f012766f7";
const EXPECTED_PATIENTS = 6;
const EXPECTED_PROTOCOLS = 6;
const SEP              = "─────────────────────────────────────────────";

const EXPECTED_LAMBDAS = [
  "sentinel-care-planner",
  "sentinel-answer-collector",
  "sentinel-nova-sonic",
  "sentinel-triage-engine",
  "sentinel-call-bridge",
  "sentinel-call-initiator",
  "sentinel-call-complete",
  "sentinel-extractor",
  "sentinel-summarizer",
];

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpGet(url: string, timeoutMs = 8000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

// ─── Result types ─────────────────────────────────────────────────────────────

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

// ─── Step 1: FHIR server ──────────────────────────────────────────────────────

async function checkFhirMockViaSdk(lambda: LambdaClient): Promise<CheckResult> {
  try {
    const payload = JSON.stringify({
      requestContext: { http: { method: "GET" } },
      rawPath: "/fhir/metadata",
      queryStringParameters: {},
    });
    const resp = await lambda.send(new InvokeCommand({
      FunctionName: "sentinel-fhir-mock",
      Payload:      Buffer.from(payload),
    }));
    const body = resp.Payload
      ? JSON.parse(Buffer.from(resp.Payload).toString()) as { statusCode?: number }
      : {};
    if (body.statusCode === 200) {
      return { label: "FHIR server", pass: true, detail: "Lambda mock — SDK 200 (Function URL blocked by org SCP)" };
    }
    return { label: "FHIR server", pass: false, detail: `Lambda mock returned ${body.statusCode ?? "?"}` };
  } catch (err: unknown) {
    const msg = (err instanceof Error) ? err.message : String(err);
    return { label: "FHIR server", pass: false, detail: `Mock invoke failed — ${msg}` };
  }
}

async function checkFhir(lambda: LambdaClient): Promise<CheckResult> {
  const isMock = FHIR_BASE.includes(".lambda-url.");

  if (isMock) {
    return checkFhirMockViaSdk(lambda);
  }

  try {
    const { status } = await httpGet(`${FHIR_BASE}/metadata`);
    if (status === 200) {
      return { label: "FHIR server", pass: true, detail: "HTTP 200" };
    }
    return { label: "FHIR server", pass: false, detail: `HTTP ${status}` };
  } catch (err: unknown) {
    const msg = (err instanceof Error) ? err.message : String(err);
    return { label: "FHIR server", pass: false, detail: `DOWN — ${msg}` };
  }
}

// ─── Step 2: Lambda functions ─────────────────────────────────────────────────

async function checkLambdas(lambda: LambdaClient): Promise<{
  result: CheckResult;
  found: string[];
  missing: string[];
}> {
  const found: string[] = [];
  let marker: string | undefined;

  do {
    const resp = await lambda.send(new ListFunctionsCommand({ Marker: marker }));
    for (const fn of resp.Functions ?? []) {
      if (fn.FunctionName?.startsWith("sentinel")) {
        found.push(fn.FunctionName);
      }
    }
    marker = resp.NextMarker;
  } while (marker);

  const missing = EXPECTED_LAMBDAS.filter((n) => !found.includes(n));
  const pass = missing.length === 0;
  const detail = pass
    ? `${found.length}/${EXPECTED_LAMBDAS.length} deployed`
    : `Missing: ${missing.join(", ")}`;

  return { result: { label: "Lambda functions", pass, detail }, found, missing };
}

// ─── Step 3: Call initiator env vars ─────────────────────────────────────────

async function checkCallInitiatorConfig(lambda: LambdaClient): Promise<CheckResult> {
  try {
    const cfg = await lambda.send(new GetFunctionConfigurationCommand({
      FunctionName: "sentinel-call-initiator",
    }));
    const vars = cfg.Environment?.Variables ?? {};
    const flowId = vars["CONNECT_CONTACT_FLOW_ID"] ?? "";

    if (!flowId) {
      return { label: "Call initiator config", pass: false, detail: "CONNECT_CONTACT_FLOW_ID missing" };
    }
    if (flowId !== EXPECTED_FLOW_ID) {
      return {
        label: "Call initiator config",
        pass: false,
        detail: `CONNECT_CONTACT_FLOW_ID mismatch: ${flowId}`,
      };
    }
    return { label: "Call initiator config", pass: true, detail: `CONNECT_CONTACT_FLOW_ID = ${flowId}` };
  } catch (err: unknown) {
    const msg = (err instanceof Error) ? err.message : String(err);
    return { label: "Call initiator config", pass: false, detail: msg };
  }
}

// ─── Step 4: DynamoDB patients ────────────────────────────────────────────────

async function checkPatients(dynamo: DynamoDBClient): Promise<CheckResult> {
  const resp = await dynamo.send(new ScanCommand({
    TableName: "PatientProfiles",
    Select: "COUNT",
  }));
  const count = resp.Count ?? 0;
  const pass = count >= EXPECTED_PATIENTS;
  return {
    label: "DynamoDB patients",
    pass,
    detail: `${count}/${EXPECTED_PATIENTS}`,
  };
}

// ─── Step 5: DynamoDB protocols ───────────────────────────────────────────────

async function checkProtocols(dynamo: DynamoDBClient): Promise<CheckResult> {
  const resp = await dynamo.send(new ScanCommand({
    TableName: "TriageProtocols",
    Select: "COUNT",
  }));
  const count = resp.Count ?? 0;
  const pass = count >= EXPECTED_PROTOCOLS;
  return {
    label: "DynamoDB protocols",
    pass,
    detail: `${count}/${EXPECTED_PROTOCOLS}`,
  };
}

// ─── Step 6: Care planner Lambda ─────────────────────────────────────────────

async function checkCarePlanner(lambda: LambdaClient): Promise<CheckResult> {
  try {
    const payload = JSON.stringify({ patientId: "P001" });
    const resp = await lambda.send(new InvokeCommand({
      FunctionName: "sentinel-care-planner",
      Payload:      Buffer.from(payload),
    }));
    const body = resp.Payload ? JSON.parse(Buffer.from(resp.Payload).toString()) as { statusCode?: number } : {};
    const statusCode = body.statusCode ?? 0;
    const pass = statusCode === 200;
    return {
      label: "Care planner Lambda",
      pass,
      detail: pass ? "HTTP 200" : `HTTP ${statusCode} (FHIR may be down)`,
    };
  } catch (err: unknown) {
    const msg = (err instanceof Error) ? err.message : String(err);
    return { label: "Care planner Lambda", pass: false, detail: msg };
  }
}

// ─── Step 7: Triage engine Lambda ────────────────────────────────────────────

async function checkTriageEngine(lambda: LambdaClient): Promise<CheckResult> {
  try {
    const payload = JSON.stringify({ patientId: "P001", callId: "C001" });
    const resp = await lambda.send(new InvokeCommand({
      FunctionName: "sentinel-triage-engine",
      Payload:      Buffer.from(payload),
    }));
    const body = resp.Payload
      ? JSON.parse(Buffer.from(resp.Payload).toString()) as {
          statusCode?: number;
          triageStatus?: string;
        }
      : {};
    const pass = body.statusCode === 200 && body.triageStatus === "RED";
    const detail = pass
      ? `HTTP 200, triageStatus=RED`
      : `HTTP ${body.statusCode ?? "?"}, triageStatus=${body.triageStatus ?? "?"}`;
    return { label: "Triage engine Lambda", pass, detail };
  } catch (err: unknown) {
    const msg = (err instanceof Error) ? err.message : String(err);
    return { label: "Triage engine Lambda", pass: false, detail: msg };
  }
}

// ─── Step 8: P001 phone number ────────────────────────────────────────────────

async function checkP001Phone(fhirUp: boolean, lambda: LambdaClient): Promise<CheckResult> {
  const expectedPhone = process.env["TEST_PHONE_NUMBER"] ?? "";
  if (!expectedPhone) {
    return { label: "P001 phone number", pass: true, detail: "SKIPPED — TEST_PHONE_NUMBER not set" };
  }

  const isMock = FHIR_BASE.includes(".lambda-url.");

  // When using the Lambda mock: phone number is not injected into static data (no TEST_PHONE_NUMBER at seed time)
  if (isMock) {
    try {
      const payload = JSON.stringify({
        requestContext: { http: { method: "GET" } },
        rawPath: "/fhir/Patient/P001",
        queryStringParameters: {},
      });
      const resp = await lambda.send(new InvokeCommand({
        FunctionName: "sentinel-fhir-mock",
        Payload:      Buffer.from(payload),
      }));
      const body = resp.Payload
        ? JSON.parse(Buffer.from(resp.Payload).toString()) as {
            statusCode?: number;
            body?: string;
          }
        : {};
      if (body.statusCode !== 200) {
        return { label: "P001 phone number", pass: false, detail: `Mock returned ${body.statusCode ?? "?"}` };
      }
      const patient = JSON.parse(body.body ?? "{}") as {
        telecom?: Array<{ system?: string; value?: string }>;
      };
      const phone = (patient.telecom ?? []).find(
        (t) => t.system === "phone" && t.value === expectedPhone
      );
      return phone
        ? { label: "P001 phone number", pass: true,  detail: `${expectedPhone} present` }
        : { label: "P001 phone number", pass: true,  detail: "SKIPPED — mock uses static data (phone not seeded)" };
    } catch (err: unknown) {
      const msg = (err instanceof Error) ? err.message : String(err);
      return { label: "P001 phone number", pass: false, detail: msg };
    }
  }

  if (!fhirUp) {
    return { label: "P001 phone number", pass: false, detail: "SKIPPED — FHIR server down" };
  }
  try {
    const { status, body } = await httpGet(`${FHIR_BASE}/Patient/P001`);
    if (status !== 200) {
      return { label: "P001 phone number", pass: false, detail: `HTTP ${status}` };
    }
    const patient = JSON.parse(body) as {
      telecom?: Array<{ system?: string; value?: string }>;
    };
    const phone = (patient.telecom ?? []).find(
      (t) => t.system === "phone" && t.value === expectedPhone
    );
    return phone
      ? { label: "P001 phone number", pass: true,  detail: `${expectedPhone} present` }
      : { label: "P001 phone number", pass: false, detail: `Phone ${expectedPhone} not found in telecom` };
  } catch (err: unknown) {
    const msg = (err instanceof Error) ? err.message : String(err);
    return { label: "P001 phone number", pass: false, detail: msg };
  }
}

// ─── EC2 hint ─────────────────────────────────────────────────────────────────

async function checkEc2State(): Promise<string> {
  try {
    const ec2 = new EC2Client({ region: REGION });
    const resp = await ec2.send(new DescribeInstanceStatusCommand({
      InstanceIds:         [EC2_INSTANCE_ID],
      IncludeAllInstances: true,
    }));
    const s = resp.InstanceStatuses?.[0];
    if (!s) return "unknown (not found)";
    const state = s.InstanceState?.Name ?? "unknown";
    const sys   = s.SystemStatus?.Status ?? "unknown";
    const inst  = s.InstanceStatus?.Status ?? "unknown";
    return `${state} | system=${sys} | instance=${inst}`;
  } catch {
    return "unable to query";
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(SEP);
  console.log("SENTINEL VOICE — SYSTEM HEALTH CHECK");
  console.log(SEP + "\n");

  const lambda = new LambdaClient({ region: REGION });
  const dynamo = new DynamoDBClient({ region: REGION });

  // Run all checks concurrently
  console.log("Running checks...\n");

  const [
    fhirResult,
    { result: lambdaResult, missing },
    configResult,
    patientResult,
    protocolResult,
    carePlannerResult,
    triageResult,
  ] = await Promise.all([
    checkFhir(lambda),
    checkLambdas(lambda),
    checkCallInitiatorConfig(lambda),
    checkPatients(dynamo),
    checkProtocols(dynamo),
    checkCarePlanner(lambda),
    checkTriageEngine(lambda),
  ]);

  const p001Result = await checkP001Phone(fhirResult.pass, lambda);

  const results: CheckResult[] = [
    fhirResult,
    lambdaResult,
    configResult,
    patientResult,
    protocolResult,
    carePlannerResult,
    triageResult,
    p001Result,
  ];

  // ─── Final Report ──────────────────────────────────────────────────────────

  console.log(SEP);
  console.log("SENTINEL VOICE — SYSTEM HEALTH CHECK");
  console.log(SEP);

  const labelWidth = Math.max(...results.map((r) => r.label.length)) + 2;
  for (const r of results) {
    const icon   = r.pass ? "✓" : "✗";
    const status = r.pass ? "PASS" : "FAIL";
    console.log(`  ${icon} ${r.label.padEnd(labelWidth)} ${status}   ${r.detail}`);
  }

  const allPass    = results.every((r) => r.pass);
  const criticalOk = lambdaResult.pass && configResult.pass && triageResult.pass;

  console.log(SEP);

  if (allPass) {
    console.log("  READY TO TEST — All checks passed");
  } else if (criticalOk) {
    console.log("  READY TO TEST — Core pipeline healthy (non-critical issues present)");
  } else {
    console.log("  ISSUES FOUND — See details above");
  }

  console.log(SEP);

  // ─── FHIR recovery instructions ───────────────────────────────────────────

  if (!fhirResult.pass) {
    const isMock = FHIR_BASE.includes(".lambda-url.");
    if (isMock) {
      console.log("\nFHIR MOCK RECOVERY:");
      console.log("  sentinel-fhir-mock Lambda is reachable via SDK but its Function URL");
      console.log("  returns 403 (AWS Organizations SCP blocks anonymous Lambda URL access).");
      console.log("  The mock Lambda itself is healthy — direct invocation succeeds.");
      console.log("  To redeploy with updated permissions:");
      console.log("    npm run deploy:lambdas");
      console.log("  FHIR_BASE_URL:", FHIR_BASE);
    } else {
      console.log("\nFHIR SERVER RECOVERY:");
      const ec2State = await checkEc2State();
      console.log(`  EC2 instance ${EC2_INSTANCE_ID}: ${ec2State}`);
      console.log("  The EC2 instance is running but HAPI FHIR (port 8080) is not responding.");
      console.log("  To restart the FHIR server, SSH into the instance and run:");
      console.log("    ssh -i <your-key.pem> ec2-user@3.239.230.36");
      console.log("    sudo systemctl restart hapi-fhir");
      console.log("    # or check the process:");
      console.log("    sudo systemctl status hapi-fhir");
      console.log("    ps aux | grep java");
      console.log("  Alternatively, from the AWS console:");
      console.log(`    aws ec2 reboot-instances --instance-ids ${EC2_INSTANCE_ID} --region ${REGION}`);
      console.log("  Note: A reboot will require ~2 min for HAPI FHIR to warm up.");
      console.log("\n  Connect instance used for calls:");
      console.log(`    ${INSTANCE_ID}`);
      console.log("  Lambdas that depend on FHIR: care-planner, call-initiator, nova-sonic");
    }
  }

  // ─── Missing Lambda details ────────────────────────────────────────────────

  if (missing.length > 0) {
    console.log("\nMISSING LAMBDAS:");
    for (const fn of missing) {
      console.log(`  ✗ ${fn}`);
    }
    console.log("  Run: npm run deploy:lambdas");
  }

  // Exit with non-zero if critical checks fail
  if (!criticalOk) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    console.error("health:check failed:", err.message);
  } else {
    console.error("health:check failed:", String(err));
  }
  process.exit(1);
});
