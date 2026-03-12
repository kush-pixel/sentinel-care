import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import {
  SFNClient,
  CreateStateMachineCommand,
  UpdateStateMachineCommand,
  ListStateMachinesCommand,
} from "@aws-sdk/client-sfn";

// ─── Required ARN env-var names (must match placeholders in JSON) ─────────────

const REQUIRED_ARNS: Record<string, string> = {
  LAMBDA_ARN_CALL_INITIATOR: process.env["LAMBDA_ARN_CALL_INITIATOR"] ?? "",
  LAMBDA_ARN_CALL_COMPLETE:  process.env["LAMBDA_ARN_CALL_COMPLETE"]  ?? "",
  LAMBDA_ARN_INCOMPLETE:     process.env["LAMBDA_ARN_INCOMPLETE"]     ?? "",
};

// ─── Pre-flight: all ARNs must be present ─────────────────────────────────────

const missing = Object.entries(REQUIRED_ARNS)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length > 0) {
  console.error("Cannot deploy — the following Lambda ARNs are not set in .env:");
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}

// ─── Load and substitute placeholders ────────────────────────────────────────

const smPath = path.resolve(__dirname, "call-state-machine.json");
let definition = fs.readFileSync(smPath, "utf-8");

for (const [key, value] of Object.entries(REQUIRED_ARNS)) {
  definition = definition.replace(new RegExp(key, "g"), value);
}

// Verify no unresolved placeholders remain
const remaining = definition.match(/LAMBDA_ARN_\w+/g);
if (remaining) {
  console.error("Unresolved placeholders after substitution:", remaining.join(", "));
  process.exit(1);
}

// ─── Deploy via AWS SDK ───────────────────────────────────────────────────────

const sfnClient = new SFNClient({
  region: process.env["AWS_REGION"] ?? "us-east-1",
});

const STATE_MACHINE_NAME = "sentinel-call-state-machine";
const roleArn = process.env["SFN_ROLE_ARN"] ?? "";

if (!roleArn) {
  console.error("SFN_ROLE_ARN not set in .env");
  process.exit(1);
}

async function deploy(): Promise<void> {
  // Check if a state machine with this name already exists
  const listResp = await sfnClient.send(new ListStateMachinesCommand({}));
  const existing = listResp.stateMachines?.find(
    (sm) => sm.name === STATE_MACHINE_NAME
  );

  let stateMachineArn: string;

  if (existing?.stateMachineArn) {
    // Update existing
    console.log(`Updating existing state machine: ${existing.stateMachineArn}`);
    await sfnClient.send(
      new UpdateStateMachineCommand({
        stateMachineArn: existing.stateMachineArn,
        definition,
        roleArn,
      })
    );
    stateMachineArn = existing.stateMachineArn;
  } else {
    // Create new
    console.log(`Creating state machine: ${STATE_MACHINE_NAME}`);
    const createResp = await sfnClient.send(
      new CreateStateMachineCommand({
        name:       STATE_MACHINE_NAME,
        definition,
        roleArn,
        type:       "STANDARD",
      })
    );
    stateMachineArn = createResp.stateMachineArn ?? "";
  }

  // Save ARN to file
  const arnFile = path.resolve(__dirname, "../.state-machine-arn");
  fs.writeFileSync(arnFile, stateMachineArn, "utf-8");

  console.log(`\nState machine ARN: ${stateMachineArn}`);
  console.log(`Add this to .env as STATE_MACHINE_ARN=${stateMachineArn}\n`);
}

deploy().catch((err: unknown) => {
  console.error("Deploy failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
