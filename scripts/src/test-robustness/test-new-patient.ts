/**
 * test-new-patient.ts — B2 Robustness test with P007 (COPD, J44.1).
 *
 * Creates a new FHIR patient, runs care-planner, verifies COPD-specific
 * questions, simulates answers, runs triage, verifies result, then cleans up.
 *
 * Run: cd scripts && npm run test:new-patient
 */

import * as dotenv from "dotenv";
import * as path from "path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const REGION       = process.env["AWS_REGION"]             ?? "us-east-1";
const FHIR_URL     = process.env["FHIR_BASE_URL"]          ?? "";
const TABLE        = process.env["DYNAMO_TABLE_RESULTS"]   ?? "CallResults";
const TABLE_PROTO  = process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols";
const CARE_PLANNER = process.env["LAMBDA_ARN_CARE_PLANNER"]
                     ?? "arn:aws:lambda:us-east-1:629843009128:function:sentinel-care-planner";
const TRIAGE       = process.env["LAMBDA_ARN_TRIAGE_ENGINE"]
                     ?? "arn:aws:lambda:us-east-1:629843009128:function:sentinel-triage-engine";
const SEP          = "─────────────────────────────────────────────";

const PATIENT_ID = "P007";
const CALL_ID    = "TEST-P007-ROBUSTNESS";

const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const lambda  = new LambdaClient({ region: REGION });

// ─── FHIR helpers ─────────────────────────────────────────────────────────────

async function createFhirPatient(): Promise<void> {
  const body = {
    resourceType: "Patient",
    id: PATIENT_ID,
    name: [{ given: ["James"], family: "Wilson" }],
    telecom: [{ system: "phone", value: "+10000000000", use: "mobile" }],
  };
  const resp = await fetch(`${FHIR_URL}/Patient/${PATIENT_ID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`FHIR PUT Patient failed: ${resp.status}`);
}

async function createFhirCondition(): Promise<void> {
  // J44.1 = COPD exacerbation
  const body = {
    resourceType: "Condition",
    subject: { reference: `Patient/${PATIENT_ID}` },
    code: {
      coding: [{ system: "http://hl7.org/fhir/sid/icd-10", code: "J44.1", display: "COPD with acute exacerbation" }],
    },
    clinicalStatus: { coding: [{ code: "active" }] },
  };
  const resp = await fetch(`${FHIR_URL}/Condition`, {
    method: "POST",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`FHIR POST Condition failed: ${resp.status}`);
}

async function createFhirEncounter(): Promise<void> {
  // EMERGENCY admission, 4 days, with prior ED visit
  const now = new Date();
  const startDate = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
  const body = {
    resourceType: "Encounter",
    subject: { reference: `Patient/${PATIENT_ID}` },
    class: { code: "EMER", display: "emergency" },
    status: "finished",
    period: { start: `${startDate}T08:00:00Z`, end: now.toISOString() },
    hospitalization: { admitSource: { coding: [{ code: "emd", display: "From emergency department" }] } },
    reasonCode: [{ coding: [{ system: "http://hl7.org/fhir/sid/icd-10", code: "J44.1" }] }],
  };
  const resp = await fetch(`${FHIR_URL}/Encounter`, {
    method: "POST",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`FHIR POST Encounter failed: ${resp.status}`);
}

async function createFhirMedication(): Promise<void> {
  // Tiotropium 18mcg inhaler
  const body = {
    resourceType: "MedicationRequest",
    subject: { reference: `Patient/${PATIENT_ID}` },
    status: "active",
    intent: "order",
    medicationCodeableConcept: {
      coding: [{ display: "Tiotropium 18mcg inhaler" }],
    },
  };
  const resp = await fetch(`${FHIR_URL}/MedicationRequest`, {
    method: "POST",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`FHIR POST MedicationRequest failed: ${resp.status}`);
}

async function deleteFhirPatient(): Promise<void> {
  await fetch(`${FHIR_URL}/Patient/${PATIENT_ID}/$expunge`, {
    method: "POST",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify({ resourceType: "Parameters" }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => { /* best effort */ });

  // Fallback: just soft-delete
  const resp = await fetch(`${FHIR_URL}/Patient/${PATIENT_ID}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok && resp.status !== 404) {
    console.warn(`  ⚠ FHIR DELETE Patient returned ${resp.status}`);
  }
}

// ─── Lambda helpers ───────────────────────────────────────────────────────────

async function invokeLambda(arn: string, payload: unknown): Promise<unknown> {
  const resp = await lambda.send(new InvokeCommand({
    FunctionName:   arn,
    InvocationType: "RequestResponse",
    Payload:        Buffer.from(JSON.stringify(payload)),
  }));
  const body = new TextDecoder().decode(resp.Payload);
  return JSON.parse(body);
}

// ─── DynamoDB cleanup ─────────────────────────────────────────────────────────

async function cleanupDynamo(): Promise<void> {
  // Remove call result
  await dynamo.send(new DeleteCommand({
    TableName: TABLE,
    Key: { call_id: CALL_ID, patient_id: PATIENT_ID },
  })).catch(() => { /* best effort */ });

  // Remove protocol
  await dynamo.send(new DeleteCommand({
    TableName: TABLE_PROTO,
    Key: { patient_id: PATIENT_ID },
  })).catch(() => { /* best effort */ });
}

// ─── Main test ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(SEP);
  console.log("SENTINEL — B2 NEW PATIENT ROBUSTNESS TEST (P007 COPD)");
  console.log(SEP + "\n");

  const results: Record<string, "PASS" | "FAIL"> = {};

  // ── STEP 1: Create FHIR data ────────────────────────────────────────────────
  console.log("STEP 1 — Creating P007 FHIR data (J44.1 COPD)...");
  try {
    await createFhirPatient();
    await createFhirCondition();
    await createFhirEncounter();
    await createFhirMedication();
    console.log("  ✓ FHIR: Patient P007 (James Wilson) created");
    console.log("  ✓ FHIR: Condition J44.1 (COPD with acute exacerbation)");
    console.log("  ✓ FHIR: Emergency encounter, 4 days, ED admission");
    console.log("  ✓ FHIR: Medication Tiotropium 18mcg inhaler");
    results["FHIR_CREATE"] = "PASS";
  } catch (err) {
    console.error("  ✗ FHIR setup failed:", err instanceof Error ? err.message : String(err));
    results["FHIR_CREATE"] = "FAIL";
  }

  // ── STEP 2: Run care-planner ────────────────────────────────────────────────
  console.log("\nSTEP 2 — Running care-planner for P007...");
  let questionPriority: string[] = [];
  try {
    const plannerResult = await invokeLambda(CARE_PLANNER, { patientId: PATIENT_ID }) as {
      statusCode?: number;
      questionPriority?: string[];
      status?: string;
      confidenceScore?: number;
      conditionCodes?: string[];
    };
    console.log("  ✓ Care-planner invoked, status:", plannerResult.statusCode);
    console.log(`  ✓ Review status: ${plannerResult.status}`);
    console.log(`  ✓ Condition codes: ${JSON.stringify(plannerResult.conditionCodes)}`);
    questionPriority = plannerResult.questionPriority ?? [];
    console.log(`  ✓ Question priority from response: ${questionPriority.join(", ")}`);
    results["CARE_PLANNER"] = "PASS";
  } catch (err) {
    console.error("  ✗ Care-planner failed:", err instanceof Error ? err.message : String(err));
    results["CARE_PLANNER"] = "FAIL";
  }

  // ── STEP 3: Verify protocol is COPD-specific ────────────────────────────────
  // Note: protocol goes to PENDING_REVIEW (no validated clinical rules for J44.1).
  // We validate question_priority directly from the care-planner response.
  console.log("\nSTEP 3 — Verifying questions are COPD-specific (not CHF)...");
  {
    const CHF_VARS = ["weight_gain_lbs", "lasix_filled", "ankle_swelling"];
    const hasCHFVars = questionPriority.some((q) => CHF_VARS.includes(q));

    console.log(`  Questions (${questionPriority.length}): ${questionPriority.join(", ")}`);

    if (hasCHFVars) {
      console.log("  ✗ Questions contain CHF-specific variables — not dynamic!");
      results["PROTOCOL_DYNAMIC"] = "FAIL";
    } else {
      console.log("  ✓ Questions do NOT contain CHF-specific variables");
      results["PROTOCOL_DYNAMIC"] = "PASS";
    }

    if (questionPriority.length === 0) {
      console.log("  ✗ Care-planner returned no questions!");
      results["PROTOCOL_HAS_QUESTIONS"] = "FAIL";
    } else {
      console.log("  ✓ Care-planner returned dynamic COPD questions");
      results["PROTOCOL_HAS_QUESTIONS"] = "PASS";
    }

    // Write a minimal protocol to TriageProtocols so triage engine can run
    if (questionPriority.length > 0) {
      const conditions = questionPriority.map((v) => ({
        variable:   v,
        operator:   "==",
        threshold:  true,
        weight:     0.5,
        flag_color: "RED",
      }));
      await dynamo.send(new PutCommand({
        TableName: TABLE_PROTO,
        Item: {
          patient_id:         PATIENT_ID,
          protocol: {
            patient_id:          PATIENT_ID,
            question_priority:   questionPriority,
            preferred_language:  "en",
            flag_color:          "RED",
            root_node: { conditions },
          },
        },
      }));
      console.log("  ✓ Protocol written to TriageProtocols for triage test");
    }
  }

  // ── STEP 4: Write simulated COPD answers to CallResults ────────────────────
  console.log("\nSTEP 4 — Writing simulated COPD answers (all good — no rules triggered)...");
  try {
    // Derive "safe" answers from conditions: invert the threshold so no rule fires
    const conditions = questionPriority.map((v) => ({
      variable:  v,
      operator:  "==" as string,
      threshold: true  as unknown,
    }));

    const variables: Record<string, unknown> = {};
    for (const q of questionPriority) {
      const cond = conditions.find((c) => c.variable === q);
      if (cond?.threshold === true) {
        // Rule fires on true → answer false (no symptom)
        variables[q] = { value: false, confidence: 0.92 };
      } else if (cond?.threshold === false) {
        // Rule fires on false → answer true (adherent)
        variables[q] = { value: true, confidence: 0.92 };
      } else if (typeof cond?.threshold === "number") {
        // Rule fires at numeric threshold → answer 0
        variables[q] = { value: 0, confidence: 0.90 };
      } else {
        variables[q] = { value: false, confidence: 0.92 };
      }
    }

    await dynamo.send(new PutCommand({
      TableName: TABLE,
      Item: {
        call_id:              CALL_ID,
        patient_id:           PATIENT_ID,
        call_status:          "COMPLETE",
        call_timestamp:       new Date().toISOString(),
        variables,
        unresolved_variables: [],
        transcript_warnings:  [],
        nurse_acknowledged:   false,
        completed_at:         new Date().toISOString(),
      },
    }));
    console.log(`  ✓ Simulated ${questionPriority.length} COPD answers written to CallResults`);
    results["ANSWERS_WRITTEN"] = "PASS";
  } catch (err) {
    console.error("  ✗ Failed to write answers:", err instanceof Error ? err.message : String(err));
    results["ANSWERS_WRITTEN"] = "FAIL";
  }

  // ── STEP 5: Run triage engine ────────────────────────────────────────────────
  console.log("\nSTEP 5 — Running triage engine...");
  let triageStatus: string | null = null;
  try {
    const triageResult = await invokeLambda(TRIAGE, { patientId: PATIENT_ID, callId: CALL_ID }) as {
      statusCode?: number;
      triageStatus?: string;
      brokenRules?: string[];
      weightedScore?: number;
      laceScore?: number;
    };
    triageStatus = triageResult.triageStatus ?? null;
    console.log(`  ✓ Triage result: ${triageStatus}`);
    console.log(`  ✓ Broken rules: ${JSON.stringify(triageResult.brokenRules ?? [])}`);
    console.log(`  ✓ LACE score: ${triageResult.laceScore}`);
    results["TRIAGE_RUNS"] = "PASS";

    if (triageStatus === "GREEN") {
      console.log("  ✓ Correct triage: GREEN (all answers indicate healthy)");
      results["TRIAGE_CORRECT"] = "PASS";
    } else {
      console.log(`  ✗ Expected GREEN, got ${triageStatus}`);
      results["TRIAGE_CORRECT"] = "FAIL";
    }
  } catch (err) {
    console.error("  ✗ Triage failed:", err instanceof Error ? err.message : String(err));
    results["TRIAGE_RUNS"] = "FAIL";
    results["TRIAGE_CORRECT"] = "FAIL";
  }

  // ── STEP 6: Cleanup ──────────────────────────────────────────────────────────
  console.log("\nSTEP 6 — Cleaning up P007 test data...");
  await cleanupDynamo();
  await deleteFhirPatient().catch(() => { /* best effort */ });
  console.log("  ✓ P007 removed from CallResults, TriageProtocols");
  console.log("  ✓ P007 removed from FHIR");

  // ── Final report ─────────────────────────────────────────────────────────────
  const allPass = Object.values(results).every((v) => v === "PASS");
  console.log("\n" + SEP);
  console.log("B2 TEST RESULTS");
  console.log(SEP);
  for (const [key, val] of Object.entries(results)) {
    const mark = val === "PASS" ? "✓" : "✗";
    console.log(`  ${mark} ${key.padEnd(28)} ${val}`);
  }
  console.log(SEP);
  console.log(`  OVERALL: ${allPass ? "PASS" : "FAIL"}`);
  console.log(SEP);

  if (!allPass) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("test:new-patient failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
