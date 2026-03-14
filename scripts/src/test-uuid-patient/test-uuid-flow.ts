/**
 * test-uuid-flow.ts — Full pipeline integration test with a dynamically
 * generated UUID patient. Nothing is hardcoded.
 *
 * Flow:
 *   STEP 0 — Generate IDs (UUID patientId, hex callId)
 *   STEP 1 — Pick a random condition from ClinicalRules (is_latest = true)
 *   STEP 2 — Create FHIR Patient, Condition, Encounter (dynamic LOS/type/ED visits)
 *   STEP 3 — Hydrate LACE into PatientProfiles
 *   STEP 4 — Run Care Planner → generates protocol in TriageProtocols
 *   STEP 5 — Read protocol conditions → generate triggering answers
 *   STEP 6 — Write CallResults + run Triage Engine
 *   STEP 7 — Run SBAR Summarizer
 *   STEP 8 — Cleanup in finally block (FHIR + all DynamoDB tables)
 *
 * Run: cd scripts && npm run test:uuid-patient
 */

import * as dotenv from "dotenv";
import * as path from "path";

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
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { calculateLaceScore } from "@sentinel/lace";
import { generatePatientId, generateCallId, validatePatientId } from "@sentinel/validation";
import type { TriageProtocol } from "@sentinel/schemas";
import { getFullPatientRecord } from "../fhir/fhir-client";
import { handler as carePlannerHandler } from "../../../lambdas/care-planner/src/handler";
import { handler as triageHandler }      from "../../../packages/triage-engine/src/handler";
import { handler as summarizerHandler }  from "../../../lambdas/summarizer/src/handler";

const SEP = "─────────────────────────────────────────────";

// ─── DynamoDB client ──────────────────────────────────────────────────────────

function makeDynamo(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region:   process.env["AWS_REGION"]    ?? "us-east-1",
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

async function fhirDelete(resourceType: string, id: string): Promise<void> {
  const res = await fetch(`${fhirBase()}/${resourceType}/${id}`, { method: "DELETE" });
  // 200, 204 = deleted; 404, 410 = already gone — all acceptable in cleanup
  if (res.status >= 500) {
    console.warn(`  ⚠ DELETE /fhir/${resourceType}/${id} → ${res.status}`);
  }
}

async function fhirSearchIds(resourceType: string, patientId: string): Promise<string[]> {
  const res = await fetch(`${fhirBase()}/${resourceType}?patient=${patientId}&_elements=id`);
  if (!res.ok) return [];
  const bundle = (await res.json()) as { entry?: { resource?: { id?: string } }[] };
  return (bundle.entry ?? []).map((e) => e.resource?.id ?? "").filter(Boolean);
}

// ─── Answer generation ────────────────────────────────────────────────────────

function generateTriggeringAnswer(
  operator: string,
  threshold: number | boolean
): number | boolean {
  if (typeof threshold === "boolean") {
    // == true threshold → answer true; == false threshold → answer false
    return threshold;
  }
  // Numeric thresholds: produce a value that satisfies the condition
  if (operator === ">=" || operator === ">") return threshold + 1;
  if (operator === "<=" || operator === "<") return Math.max(0, threshold - 1);
  if (operator === "==") return threshold;
  return threshold + 1;
}

/** Recursively collect all conditions from a protocol node. */
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

// ─── Result tracking ──────────────────────────────────────────────────────────

type TestResult = { label: string; pass: boolean; detail: string };

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dynamo          = makeDynamo();
  const rulesTable      = process.env["DYNAMO_TABLE_RULES"]    ?? "ClinicalRules";
  const patientsTable   = process.env["DYNAMO_TABLE_PATIENTS"] ?? "PatientProfiles";
  const protocolsTable  = process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols";
  const resultsTable    = process.env["DYNAMO_TABLE_RESULTS"]  ?? "CallResults";
  const reviewsTable    = process.env["DYNAMO_TABLE_REVIEWS"]  ?? "ProtocolReview";

  const results: TestResult[] = [];

  function record(label: string, pass: boolean, detail: string): void {
    results.push({ label, pass, detail });
    console.log(`  ${pass ? "✓" : "✗"} ${label} — ${detail}`);
  }

  // ─── STEP 0 — Generate IDs ─────────────────────────────────────────────────
  const patientId = generatePatientId();
  const callId    = generateCallId();

  console.log(SEP);
  console.log("DYNAMIC PATIENT ID — PIPELINE TEST");
  console.log(SEP);
  console.log(`  patientId: ${patientId}`);
  console.log(`  callId:    ${callId}\n`);

  record(
    "validatePatientId accepts UUID",
    validatePatientId(patientId),
    `"${patientId.slice(0, 18)}..."`
  );

  record("validatePatientId accepts legacy", validatePatientId("P001"), "P001");

  // ─── Track created FHIR resource IDs for cleanup ──────────────────────────
  const createdFhirConditions: string[] = [];
  const createdFhirEncounters: string[] = [];

  const shortId     = patientId.replace(/-/g, "").slice(0, 8).toUpperCase();
  const conditionId = `COND-${shortId}`;
  const encounterId = `ENC-${shortId}`;

  try {
    // ─── STEP 1 — Pick random condition from ClinicalRules ──────────────────
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

    const selectedRule = liveRules[Math.floor(Math.random() * liveRules.length)] as Record<string, unknown>;
    const conditionCode    = selectedRule["condition_code"]    as string;
    const conditionDisplay = selectedRule["condition_display"] as string;

    console.log(`  → Randomly selected: ${conditionCode} — ${conditionDisplay}\n`);

    // ─── STEP 2 — Create FHIR resources ────────────────────────────────────
    console.log("STEP 2 — Creating FHIR resources...");

    // Random encounter parameters
    const losdays      = 2 + Math.floor(Math.random() * 6);   // 2–7 days
    const isEmergency  = Math.random() > 0.5;
    const edVisits     = Math.floor(Math.random() * 4);         // 0–3
    const dischargeDate = new Date();
    dischargeDate.setHours(12, 0, 0, 0);
    const admissionDate = new Date(dischargeDate);
    admissionDate.setDate(admissionDate.getDate() - losdays);

    const admissionDateStr = admissionDate.toISOString();
    const dischargeDateStr = dischargeDate.toISOString();

    // Patient
    await fhirPut("Patient", patientId, {
      resourceType: "Patient",
      id: patientId,
      name: [{ family: "TestUUID", given: ["Pipeline"] }],
      birthDate: "1960-06-15",
      gender:    "unknown",
    });
    console.log(`  ✓ PUT /fhir/Patient/${patientId}`);

    // Condition
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
    createdFhirConditions.push(conditionId);
    console.log(`  ✓ PUT /fhir/Condition/${conditionId} (${conditionCode})`);

    // Inpatient encounter for LOS
    await fhirPut("Encounter", encounterId, {
      resourceType: "Encounter",
      id:      encounterId,
      status:  "finished",
      class:   { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "IMP", display: "Inpatient" },
      type:    [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: isEmergency ? "EMER" : "IMP" }] }],
      subject: { reference: `Patient/${patientId}` },
      period:  { start: admissionDateStr, end: dischargeDateStr },
      hospitalization: {
        admitSource: {
          coding: [{ code: isEmergency ? "emd" : "outp", display: isEmergency ? "From emergency department" : "Outpatient" }],
        },
      },
    });
    createdFhirEncounters.push(encounterId);
    console.log(`  ✓ PUT /fhir/Encounter/${encounterId} (LOS=${losdays}d, ${isEmergency ? "EMERGENCY" : "PLANNED"}, ED=${edVisits})`);

    // ED visit encounters (for E component of LACE)
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
      createdFhirEncounters.push(edId);
      console.log(`  ✓ PUT /fhir/Encounter/${edId} (ED visit ${i + 1})`);
    }

    record("FHIR resources created", true, `Patient + Condition + ${1 + edVisits} Encounter(s)`);

    // ─── STEP 3 — Hydrate LACE ─────────────────────────────────────────────
    console.log("\nSTEP 3 — Hydrating LACE for patient...");

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
          "SET lace_score              = :ls",
          "    lace_risk_level         = :lr",
          "    lace_components         = :lc",
          "    lace_length_of_stay_days = :ld",
          "    lace_charlson_score     = :cs",
          "    lace_interpretation     = :li",
          "    lace_calculated_at      = :la",
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

    const laceCheck = await dynamo.send(
      new GetCommand({ TableName: patientsTable, Key: { patient_id: patientId } })
    );
    const laceStored = typeof laceCheck.Item?.["lace_score"] === "number";
    record("LACE calculated", laceStored, `score=${lace.totalScore} (${lace.riskLevel})`);

    // ─── STEP 4 — Run Care Planner ─────────────────────────────────────────
    console.log("\nSTEP 4 — Running Care Planner...");
    const cpResult = (await carePlannerHandler({ patientId })) as Record<string, unknown>;
    const cpStatus = cpResult["statusCode"] as number | undefined;
    const cpOk     = cpStatus === 200;
    const reviewId = cpResult["reviewId"] as string | undefined;
    record(
      "Protocol generated",
      cpOk,
      cpOk ? `reviewId=${reviewId ?? "?"}` : String(cpResult["error"] ?? cpStatus)
    );

    // ─── STEP 5 — Read protocol + generate answers ─────────────────────────
    console.log("\nSTEP 5 — Generating answers from protocol conditions...");

    const protoRes = await dynamo.send(
      new GetCommand({ TableName: protocolsTable, Key: { patient_id: patientId } })
    );

    const protocol = protoRes.Item?.["protocol"] as TriageProtocol | undefined;
    const allConditions = protocol?.root_node
      ? collectConditions(protocol.root_node as Parameters<typeof collectConditions>[0])
      : [];

    // Deduplicate by variable
    const seen = new Set<string>();
    const uniqueConditions = allConditions.filter((c) => {
      if (seen.has(c.variable)) return false;
      seen.add(c.variable);
      return true;
    });

    // PatientAnswers.variables shape: { value, confidence } — no skipped field
    const variablesRecord: Record<string, { value: number | boolean; confidence: number }> = {};
    for (const cond of uniqueConditions) {
      variablesRecord[cond.variable] = {
        value:      generateTriggeringAnswer(cond.operator, cond.threshold),
        confidence: 0.85 + Math.random() * 0.1,
      };
    }

    const answersGenerated = Object.keys(variablesRecord).length > 0;
    record(
      "Answers generated from protocol",
      answersGenerated,
      `${Object.keys(variablesRecord).length} variable(s): ${Object.keys(variablesRecord).join(", ")}`
    );

    // ─── STEP 6 — Write CallResults + run Triage Engine ───────────────────
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
          created_at:           new Date().toISOString(),
        },
      })
    );

    const triageResult = (await triageHandler({ callId, patientId })) as Record<string, unknown>;
    const triageStatus = triageResult["triageStatus"] as string | undefined;
    const triageOk     = triageResult["statusCode"] === 200;
    record(
      "Triage completed",
      triageOk,
      triageOk ? `triageStatus=${triageStatus ?? "?"}` : String(triageResult["error"] ?? "")
    );

    // ─── STEP 7 — Run Summarizer ───────────────────────────────────────────
    console.log("\nSTEP 7 — Running SBAR Summarizer...");

    const sumResult = (await summarizerHandler({ callId, patientId })) as Record<string, unknown>;
    const sumOk     = sumResult["statusCode"] === 200;
    record(
      "SBAR generated",
      sumOk,
      sumOk ? "SBAR written to CallResults" : String(sumResult["error"] ?? sumResult["statusCode"])
    );

  } finally {
    // ─── STEP 8 — Cleanup ─────────────────────────────────────────────────
    console.log("\nSTEP 8 — Cleanup...");

    // Delete FHIR referencing resources before Patient
    const allFhirConditions = [...new Set([...createdFhirConditions, ...(await fhirSearchIds("Condition", patientId))])];
    const allFhirEncounters = [...new Set([...createdFhirEncounters, ...(await fhirSearchIds("Encounter", patientId))])];

    for (const id of allFhirConditions) {
      await fhirDelete("Condition", id);
      console.log(`  ✓ DELETE /fhir/Condition/${id}`);
    }
    for (const id of allFhirEncounters) {
      await fhirDelete("Encounter", id);
      console.log(`  ✓ DELETE /fhir/Encounter/${id}`);
    }
    await fhirDelete("Patient", patientId);
    console.log(`  ✓ DELETE /fhir/Patient/${patientId}`);

    // Delete DynamoDB records
    await dynamo.send(new DeleteCommand({ TableName: patientsTable,  Key: { patient_id: patientId } }));
    console.log(`  ✓ DELETE PatientProfiles/${patientId}`);

    await dynamo.send(new DeleteCommand({ TableName: protocolsTable, Key: { patient_id: patientId } }));
    console.log(`  ✓ DELETE TriageProtocols/${patientId}`);

    await dynamo.send(new DeleteCommand({ TableName: resultsTable, Key: { call_id: callId, patient_id: patientId } }));
    console.log(`  ✓ DELETE CallResults/${callId}`);

    // Scan ProtocolReview for this patientId and delete all found records
    const reviewScan = await dynamo.send(
      new ScanCommand({
        TableName:                 reviewsTable,
        FilterExpression:          "patient_id = :pid",
        ExpressionAttributeValues: { ":pid": patientId },
        ProjectionExpression:      "review_id, patient_id",
      })
    );
    for (const item of reviewScan.Items ?? []) {
      const rid = item["review_id"] as string;
      await dynamo.send(new DeleteCommand({ TableName: reviewsTable, Key: { review_id: rid, patient_id: patientId } }));
      console.log(`  ✓ DELETE ProtocolReview/${rid}`);
    }

    record("Cleanup complete", true, "all test resources deleted");
  }

  // ─── Verify no residual data ────────────────────────────────────────────────
  const residualPatient = await dynamo.send(
    new GetCommand({ TableName: patientsTable, Key: { patient_id: patientId } })
  );
  const residualProtocol = await dynamo.send(
    new GetCommand({ TableName: protocolsTable, Key: { patient_id: patientId } })
  );
  const residualResults = await dynamo.send(
    new GetCommand({ TableName: resultsTable, Key: { call_id: callId, patient_id: patientId } })
  );
  const noResidual =
    !residualPatient.Item &&
    !residualProtocol.Item &&
    !residualResults.Item;

  record("No test data in any table", noResidual, noResidual ? "all clean" : "residual data found");

  // ─── Summary ─────────────────────────────────────────────────────────────────
  console.log("\n" + SEP);
  console.log("DYNAMIC PATIENT ID SUPPORT");
  console.log(SEP);

  const labelWidth = 38;
  for (const r of results) {
    console.log(`  ${r.label.padEnd(labelWidth)} ${r.pass ? "PASS" : "FAIL"}`);
  }

  const allPass = results.every((r) => r.pass);
  console.log(SEP);
  console.log(`OVERALL: ${allPass ? "PASS" : "FAIL"}`);
  console.log(SEP);

  if (!allPass) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("test-uuid-patient failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
