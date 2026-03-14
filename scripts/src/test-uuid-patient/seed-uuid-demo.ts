/**
 * seed-uuid-demo.ts — Creates a UUID patient, runs the full pipeline, and
 * persists all created IDs to .uuid-demo-ids.json WITHOUT cleaning up, so
 * the record can be viewed on the Nurse Dashboard.
 *
 * Run:   cd scripts && npm run seed:uuid-demo
 * Clean: cd scripts && npm run cleanup:uuid-demo
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

process.env["DYNAMO_ENDPOINT"]            = process.env["DYNAMO_ENDPOINT"]            ?? "http://localhost:8000";
process.env["AWS_REGION"]                 = process.env["AWS_REGION"]                 ?? "us-east-1";
process.env["FHIR_BASE_URL"]              = process.env["FHIR_BASE_URL"]              ?? "http://localhost:8080/fhir";
process.env["DYNAMO_TABLE_PROTOCOLS"]     = process.env["DYNAMO_TABLE_PROTOCOLS"]     ?? "TriageProtocols";
process.env["DYNAMO_TABLE_REVIEWS"]       = process.env["DYNAMO_TABLE_REVIEWS"]       ?? "ProtocolReview";
process.env["DYNAMO_TABLE_RULES"]         = process.env["DYNAMO_TABLE_RULES"]         ?? "ClinicalRules";
process.env["DYNAMO_TABLE_RESULTS"]       = process.env["DYNAMO_TABLE_RESULTS"]       ?? "CallResults";
process.env["DYNAMO_TABLE_PATIENTS"]      = process.env["DYNAMO_TABLE_PATIENTS"]      ?? "PatientProfiles";
process.env["BEDROCK_MODEL_CARE_PLANNER"] = process.env["BEDROCK_MODEL_CARE_PLANNER"] ?? "amazon.nova-lite-v1:0";
process.env["BEDROCK_MODEL_SUMMARIZER"]   = process.env["BEDROCK_MODEL_SUMMARIZER"]   ?? "amazon.nova-lite-v1:0";
process.env["POLLY_ENABLED"]              = "false";
process.env["CONFIDENCE_THRESHOLD"]       = process.env["CONFIDENCE_THRESHOLD"]       ?? "0.7";
process.env["ESCALATION_TOPIC_ARN"]       = process.env["ESCALATION_TOPIC_ARN"]       ?? "arn:aws:sns:us-east-1:629843009128:sentinel-red-escalation";

import fetch from "node-fetch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { calculateLaceScore } from "@sentinel/lace";
import { generatePatientId, generateCallId } from "@sentinel/validation";
import type { TriageProtocol } from "@sentinel/schemas";
import { getFullPatientRecord } from "../fhir/fhir-client";
import { handler as carePlannerHandler } from "../../../lambdas/care-planner/src/handler";
import { handler as triageHandler }      from "../../../packages/triage-engine/src/handler";
import { handler as summarizerHandler }  from "../../../lambdas/summarizer/src/handler";

const IDS_FILE = path.resolve(__dirname, "../../../.uuid-demo-ids.json");
const SEP = "─────────────────────────────────────────────";

// ─── DynamoDB client ──────────────────────────────────────────────────────────

function makeDynamo(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region:   process.env["AWS_REGION"]      ?? "us-east-1",
    endpoint: process.env["DYNAMO_ENDPOINT"] ?? "http://localhost:8000",
  });
  return DynamoDBDocumentClient.from(raw);
}

function fhirBase(): string {
  return process.env["FHIR_BASE_URL"] ?? "http://localhost:8080/fhir";
}

// ─── FHIR helpers ─────────────────────────────────────────────────────────────

async function fhirPut(resourceType: string, id: string, body: object): Promise<void> {
  const res = await fetch(`${fhirBase()}/${resourceType}/${id}`, {
    method:  "PUT",
    headers: { "Content-Type": "application/fhir+json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FHIR PUT ${resourceType}/${id} failed ${res.status}: ${text.slice(0, 200)}`);
  }
}

// ─── Answer generation ────────────────────────────────────────────────────────

function generateTriggeringAnswer(
  operator: string,
  threshold: number | boolean
): number | boolean {
  if (typeof threshold === "boolean") return threshold;
  if (operator === ">=" || operator === ">") return threshold + 1;
  if (operator === "<=" || operator === "<") return Math.max(0, threshold - 1);
  if (operator === "==") return threshold;
  return threshold + 1;
}

function collectConditions(
  node: { conditions: { variable: string; operator: string; threshold: number | boolean }[]; sub_nodes?: { conditions: { variable: string; operator: string; threshold: number | boolean }[]; sub_nodes?: unknown[] }[] }
): { variable: string; operator: string; threshold: number | boolean }[] {
  const results: { variable: string; operator: string; threshold: number | boolean }[] = [
    ...node.conditions,
  ];
  for (const sub of node.sub_nodes ?? []) {
    results.push(...collectConditions(sub as typeof node));
  }
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dynamo         = makeDynamo();
  const rulesTable     = process.env["DYNAMO_TABLE_RULES"]     ?? "ClinicalRules";
  const patientsTable  = process.env["DYNAMO_TABLE_PATIENTS"]  ?? "PatientProfiles";
  const protocolsTable = process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols";
  const resultsTable   = process.env["DYNAMO_TABLE_RESULTS"]   ?? "CallResults";

  // ─── STEP 0 — Generate IDs ─────────────────────────────────────────────────
  const patientId = generatePatientId();
  const callId    = generateCallId();
  const createdAt = new Date().toISOString();

  console.log(SEP);
  console.log("UUID DEMO PATIENT — SEED");
  console.log(SEP);
  console.log(`  patientId: ${patientId}`);
  console.log(`  callId:    ${callId}\n`);

  // ─── STEP 1 — Pick random condition from ClinicalRules ─────────────────────
  console.log("STEP 1 — Selecting random condition from ClinicalRules...");

  const rulesScan = await dynamo.send(
    new ScanCommand({
      TableName:                 rulesTable,
      FilterExpression:          "is_latest = :il",
      ExpressionAttributeValues: { ":il": true },
    })
  );

  const liveRules = rulesScan.Items ?? [];
  if (liveRules.length === 0) {
    throw new Error("No rules found in ClinicalRules — run morning:start first.");
  }

  const selectedRule     = liveRules[Math.floor(Math.random() * liveRules.length)] as Record<string, unknown>;
  const conditionCode    = selectedRule["condition_code"]    as string;
  const conditionDisplay = selectedRule["condition_display"] as string;

  console.log(`  → Randomly selected: ${conditionCode} — ${conditionDisplay}\n`);

  // ─── STEP 2 — Create FHIR resources ────────────────────────────────────────
  console.log("STEP 2 — Creating FHIR resources...");

  const losdays      = 2 + Math.floor(Math.random() * 6);   // 2–7 days
  const isEmergency  = Math.random() > 0.5;
  const edVisits     = Math.floor(Math.random() * 4);         // 0–3
  const dischargeDate = new Date();
  dischargeDate.setHours(12, 0, 0, 0);
  const admissionDate = new Date(dischargeDate);
  admissionDate.setDate(admissionDate.getDate() - losdays);

  const shortId     = patientId.replace(/-/g, "").slice(0, 8).toUpperCase();
  const conditionId = `COND-${shortId}`;
  const encounterId = `ENC-${shortId}`;

  await fhirPut("Patient", patientId, {
    resourceType: "Patient",
    id:       patientId,
    name:     [{ family: "UUIDDemo", given: ["Dashboard"] }],
    birthDate: "1955-03-22",
    gender:   "unknown",
  });
  console.log(`  ✓ PUT /fhir/Patient/${patientId}`);

  await fhirPut("Condition", conditionId, {
    resourceType: "Condition",
    id:      conditionId,
    subject: { reference: `Patient/${patientId}` },
    code: {
      coding: [{
        system:  "http://hl7.org/fhir/sid/icd-10",
        code:    conditionCode,
        display: conditionDisplay,
      }],
    },
    clinicalStatus: {
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }],
    },
  });
  console.log(`  ✓ PUT /fhir/Condition/${conditionId} (${conditionCode})`);

  await fhirPut("Encounter", encounterId, {
    resourceType: "Encounter",
    id:      encounterId,
    status:  "finished",
    class:   { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "IMP", display: "Inpatient" },
    type:    [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: isEmergency ? "EMER" : "IMP" }] }],
    subject: { reference: `Patient/${patientId}` },
    period:  { start: admissionDate.toISOString(), end: dischargeDate.toISOString() },
    hospitalization: {
      admitSource: {
        coding: [{ code: isEmergency ? "emd" : "outp", display: isEmergency ? "From emergency department" : "Outpatient" }],
      },
    },
  });
  console.log(`  ✓ PUT /fhir/Encounter/${encounterId} (LOS=${losdays}d, ${isEmergency ? "EMERGENCY" : "PLANNED"}, ED=${edVisits})`);

  for (let i = 0; i < edVisits; i++) {
    const edId    = `${encounterId}-ED${i + 1}`;
    const edStart = new Date(admissionDate);
    edStart.setDate(edStart.getDate() - (i + 1) * 14);
    await fhirPut("Encounter", edId, {
      resourceType: "Encounter",
      id:     edId,
      status: "finished",
      class:  { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "EMER" },
      subject: { reference: `Patient/${patientId}` },
      period:  { start: edStart.toISOString(), end: new Date(edStart.getTime() + 4 * 3600_000).toISOString() },
    });
    console.log(`  ✓ PUT /fhir/Encounter/${edId} (ED visit ${i + 1})`);
  }

  // ─── STEP 3 — Hydrate LACE ─────────────────────────────────────────────────
  console.log("\nSTEP 3 — Hydrating LACE...");

  const fhirRecord = await getFullPatientRecord(patientId);
  const conditionCodes = fhirRecord.conditions
    .flatMap((c) => c.code.coding)
    .map((coding) => coding.code)
    .filter((code): code is string => !!code);

  const lace = calculateLaceScore({
    admissionDate: fhirRecord.encounterSummary.admissionDate,
    dischargeDate: fhirRecord.encounterSummary.dischargeDate,
    admissionType: fhirRecord.encounterSummary.admissionType,
    conditionCodes,
    recentEDVisits: fhirRecord.encounterSummary.recentEDVisits,
  });

  await dynamo.send(
    new UpdateCommand({
      TableName: patientsTable,
      Key:       { patient_id: patientId },
      UpdateExpression: [
        "SET lace_score               = :ls",
        "    lace_risk_level          = :lr",
        "    lace_components          = :lc",
        "    lace_length_of_stay_days = :ld",
        "    lace_charlson_score      = :cs",
        "    lace_interpretation      = :li",
        "    lace_calculated_at       = :la",
      ].join(", "),
      ExpressionAttributeValues: {
        ":ls": lace.totalScore,
        ":lr": lace.riskLevel,
        ":lc": lace.components,
        ":ld": lace.lengthOfStayDays,
        ":cs": lace.charlsonScore,
        ":li": lace.interpretation,
        ":la": new Date().toISOString(),
      },
    })
  );

  console.log(`  ✓ LACE score=${lace.totalScore} (${lace.riskLevel})`);

  // ─── STEP 4 — Run Care Planner ─────────────────────────────────────────────
  console.log("\nSTEP 4 — Running Care Planner...");

  const cpResult = (await carePlannerHandler({ patientId })) as Record<string, unknown>;
  if (cpResult["statusCode"] !== 200) {
    throw new Error(`Care planner failed: ${String(cpResult["error"] ?? cpResult["statusCode"])}`);
  }
  const reviewId = cpResult["reviewId"] as string | undefined;
  console.log(`  ✓ Protocol generated — reviewId=${reviewId ?? "?"}`);

  // ─── STEP 5 — Generate answers from protocol ───────────────────────────────
  console.log("\nSTEP 5 — Generating answers from protocol conditions...");

  const protoRes = await dynamo.send(
    new GetCommand({ TableName: protocolsTable, Key: { patient_id: patientId } })
  );

  const protocol = protoRes.Item?.["protocol"] as TriageProtocol | undefined;
  const allConditions = protocol?.root_node
    ? collectConditions(protocol.root_node as Parameters<typeof collectConditions>[0])
    : [];

  const seen = new Set<string>();
  const uniqueConditions = allConditions.filter((c) => {
    if (seen.has(c.variable)) return false;
    seen.add(c.variable);
    return true;
  });

  const variablesRecord: Record<string, { value: number | boolean; confidence: number }> = {};
  for (const cond of uniqueConditions) {
    variablesRecord[cond.variable] = {
      value:      generateTriggeringAnswer(cond.operator, cond.threshold),
      confidence: 0.85 + Math.random() * 0.1,
    };
  }

  console.log(`  ✓ ${Object.keys(variablesRecord).length} variable(s): ${Object.keys(variablesRecord).join(", ")}`);

  // ─── STEP 6 — Write CallResults + run Triage Engine ───────────────────────
  console.log("\nSTEP 6 — Writing CallResults and running Triage Engine...");

  await dynamo.send(
    new PutCommand({
      TableName: resultsTable,
      Item: {
        call_id:              callId,
        patient_id:           patientId,
        call_status:          "COMPLETE",
        condition_code:       conditionCode,
        lace_score:           lace.totalScore,
        lace_risk_level:      lace.riskLevel,
        variables:            variablesRecord,
        unresolved_variables: [],
        transcript_warnings:  [],
        created_at:           createdAt,
      },
    })
  );

  const triageResult = (await triageHandler({ callId, patientId })) as Record<string, unknown>;
  if (triageResult["statusCode"] !== 200) {
    throw new Error(`Triage failed: ${String(triageResult["error"] ?? "")}`);
  }
  const triageStatus = triageResult["triageStatus"] as string | undefined;
  console.log(`  ✓ Triage completed — triageStatus=${triageStatus ?? "?"}`);

  // ─── STEP 7 — Run Summarizer ───────────────────────────────────────────────
  console.log("\nSTEP 7 — Running SBAR Summarizer...");

  const sumResult = (await summarizerHandler({ callId, patientId })) as Record<string, unknown>;
  if (sumResult["statusCode"] !== 200) {
    throw new Error(`Summarizer failed: ${String(sumResult["error"] ?? sumResult["statusCode"])}`);
  }
  console.log("  ✓ SBAR written to CallResults");

  // ─── STEP 8 — Persist IDs ─────────────────────────────────────────────────
  console.log("\nSTEP 8 — Saving IDs to .uuid-demo-ids.json...");

  const demoIds = { patientId, callId, conditionCode, conditionDisplay, triageStatus, createdAt };
  fs.writeFileSync(IDS_FILE, JSON.stringify(demoIds, null, 2));
  console.log(`  ✓ Saved to ${IDS_FILE}`);

  // ─── Dashboard instructions ────────────────────────────────────────────────
  console.log("\n" + SEP);
  console.log("DEMO PATIENT READY — VIEW ON DASHBOARD");
  console.log(SEP);
  console.log(`  Patient ID:  ${patientId}`);
  console.log(`  Call ID:     ${callId}`);
  console.log(`  Condition:   ${conditionCode} — ${conditionDisplay}`);
  console.log(`  Triage:      ${triageStatus ?? "unknown"}`);
  console.log(`  LACE:        ${lace.totalScore} (${lace.riskLevel})`);
  console.log("");
  console.log("  Open the Nurse Dashboard and look for a card with:");
  console.log(`    Patient ID  → ${patientId.slice(0, 18)}...`);
  console.log(`    Status      → ${triageStatus ?? "check ProtocolReview"}`);
  console.log(`    Condition   → ${conditionDisplay}`);
  console.log("");
  console.log("  To remove this patient when done:");
  console.log("    cd scripts && npm run cleanup:uuid-demo");
  console.log(SEP);
}

main().catch((err: unknown) => {
  console.error("seed:uuid-demo failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
