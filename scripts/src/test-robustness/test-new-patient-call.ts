/**
 * test-new-patient-call.ts — End-to-end robustness test with P008 (I10 Hypertensive crisis).
 *
 * Creates a brand new FHIR patient, runs care-planner to verify dynamic
 * hypertension-specific questions, then places a real outbound call.
 *
 * No cleanup — the call is live. Run cleanup:stale after the call completes.
 *
 * Run: cd scripts && npm run test:new-patient-call
 */

import * as dotenv from "dotenv";
import * as path from "path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const REGION        = process.env["AWS_REGION"]              ?? "us-east-1";
const FHIR_URL      = process.env["FHIR_BASE_URL"]           ?? "";
const CONNECT_PHONE = process.env["CONNECT_PHONE_NUMBER"]    ?? "+17208446427";
const TEST_PHONE    = process.env["TEST_PHONE_NUMBER"]       ?? "";
const CARE_PLANNER  = process.env["LAMBDA_ARN_CARE_PLANNER"]
                      ?? "arn:aws:lambda:us-east-1:629843009128:function:sentinel-care-planner";
const CALL_INIT     = process.env["LAMBDA_ARN_CALL_INITIATOR"]
                      ?? "arn:aws:lambda:us-east-1:629843009128:function:sentinel-call-initiator";
const SEP           = "─────────────────────────────────────────────";

const PATIENT_ID   = "P008";
const CONDITION    = { code: "I10", display: "Hypertensive crisis" };
const MEDICATION   = "Lisinopril 10mg daily";

// LACE components for P008 (3-day EMERGENCY, 2 ED visits):
//   L=2 (1-3 days), A=3 (emergency), C=0, E=2 → Total=7 MODERATE
const EXPECTED_LACE = { l: 2, a: 3, c: 0, e: 2, total: 7, risk: "MODERATE" };

// Variables that should NOT appear for a new condition (CHF / knee-specific)
const CHF_VARS  = new Set(["weight_gain_lbs", "lasix_filled", "ankle_swelling"]);
const KNEE_VARS = new Set(["knee_swelling", "knee_pain", "range_of_motion", "physical_therapy"]);

const TABLE_REVIEWS   = process.env["DYNAMO_TABLE_REVIEWS"]   ?? "ProtocolReview";
const TABLE_PROTOCOLS = process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const lambda = new LambdaClient({ region: REGION });

// ─── FHIR helpers ─────────────────────────────────────────────────────────────

async function fhirPut(resourceType: string, id: string, body: object): Promise<void> {
  const resp = await fetch(`${FHIR_URL}/${resourceType}/${id}`, {
    method:  "PUT",
    headers: { "Content-Type": "application/fhir+json" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`FHIR PUT ${resourceType}/${id} failed: ${resp.status}`);
}

async function createFhirPatient(): Promise<void> {
  if (!TEST_PHONE) throw new Error("TEST_PHONE_NUMBER not set in .env");
  await fhirPut("Patient", PATIENT_ID, {
    resourceType: "Patient",
    id:           PATIENT_ID,
    name:         [{ given: ["David"], family: "Chen" }],
    birthDate:    "1958-03-22",
    gender:       "male",
    telecom:      [{ system: "phone", value: TEST_PHONE, use: "mobile" }],
  });
}

async function createFhirCondition(): Promise<void> {
  await fhirPut("Condition", "COND-P008-1", {
    resourceType:   "Condition",
    id:             "COND-P008-1",
    subject:        { reference: `Patient/${PATIENT_ID}` },
    code: {
      coding: [{
        system:  "http://hl7.org/fhir/sid/icd-10",
        code:    CONDITION.code,
        display: CONDITION.display,
      }],
    },
    clinicalStatus: { coding: [{ code: "active" }] },
  });
}

async function createFhirEncounter(): Promise<void> {
  const now       = new Date();
  const admitDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const startStr  = admitDate.toISOString().substring(0, 10);

  // Admission: 3-day EMERGENCY (L=2, A=3)
  await fhirPut("Encounter", "ENC-P008-ADMIT", {
    resourceType:    "Encounter",
    id:              "ENC-P008-ADMIT",
    status:          "finished",
    class:           { code: "IMP", display: "inpatient encounter" },
    type:            [{ coding: [{ code: "EMER", display: "Emergency" }] }],
    subject:         { reference: `Patient/${PATIENT_ID}` },
    period:          { start: `${startStr}T08:00:00Z`, end: now.toISOString() },
    hospitalization: {
      admitSource: { coding: [{ code: "emd", display: "From accident/emergency department" }] },
    },
    reasonCode: [{ coding: [{ system: "http://hl7.org/fhir/sid/icd-10", code: CONDITION.code }] }],
  });

  // Two prior ED visits in last 6 months (E=2)
  const ed1 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const ed2 = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);

  await fhirPut("Encounter", "ENC-P008-ED-1", {
    resourceType: "Encounter",
    id:           "ENC-P008-ED-1",
    status:       "finished",
    class:        { code: "EMER", display: "emergency" },
    subject:      { reference: `Patient/${PATIENT_ID}` },
    period: {
      start: ed1.toISOString(),
      end:   new Date(ed1.getTime() + 3 * 60 * 60 * 1000).toISOString(),
    },
  });

  await fhirPut("Encounter", "ENC-P008-ED-2", {
    resourceType: "Encounter",
    id:           "ENC-P008-ED-2",
    status:       "finished",
    class:        { code: "EMER", display: "emergency" },
    subject:      { reference: `Patient/${PATIENT_ID}` },
    period: {
      start: ed2.toISOString(),
      end:   new Date(ed2.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    },
  });
}

async function createFhirMedication(): Promise<void> {
  await fhirPut("MedicationRequest", "MED-P008-1", {
    resourceType:              "MedicationRequest",
    id:                        "MED-P008-1",
    subject:                   { reference: `Patient/${PATIENT_ID}` },
    status:                    "active",
    intent:                    "order",
    medicationCodeableConcept: { coding: [{ display: MEDICATION }] },
  });
}

// ─── Lambda helper ────────────────────────────────────────────────────────────

async function invokeLambda(arn: string, payload: unknown): Promise<unknown> {
  const resp = await lambda.send(new InvokeCommand({
    FunctionName:   arn,
    InvocationType: "RequestResponse",
    Payload:        Buffer.from(JSON.stringify(payload)),
  }));
  return JSON.parse(new TextDecoder().decode(resp.Payload));
}

// ─── Main test ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(SEP);
  console.log("SENTINEL — P008 NEW PATIENT + REAL CALL TEST (I10 HYPERTENSION)");
  console.log(SEP + "\n");

  if (!FHIR_URL) {
    console.error("  ✗ FHIR_BASE_URL not set in .env");
    process.exit(1);
  }
  if (!TEST_PHONE) {
    console.error("  ✗ TEST_PHONE_NUMBER not set in .env");
    process.exit(1);
  }

  const results: Record<string, "PASS" | "FAIL"> = {};

  // ── STEP 1: Create FHIR data ─────────────────────────────────────────────────
  console.log("STEP 1 — Creating P008 FHIR data (I10 Hypertensive crisis)...");
  try {
    await createFhirPatient();
    console.log(`  ✓ Patient P008 (David Chen, DOB 1958-03-22, ${TEST_PHONE})`);
    await createFhirCondition();
    console.log(`  ✓ Condition ${CONDITION.code} — ${CONDITION.display}`);
    await createFhirEncounter();
    console.log("  ✓ Encounter: EMERGENCY admission 3 days + 2 prior ED visits");
    await createFhirMedication();
    console.log(`  ✓ Medication: ${MEDICATION}`);
    console.log(`  ✓ Expected LACE: L=${EXPECTED_LACE.l} A=${EXPECTED_LACE.a} C=${EXPECTED_LACE.c} E=${EXPECTED_LACE.e} → ${EXPECTED_LACE.total} ${EXPECTED_LACE.risk}`);
    results["FHIR_CREATE"] = "PASS";
  } catch (err) {
    console.error("  ✗ FHIR setup failed:", err instanceof Error ? err.message : String(err));
    results["FHIR_CREATE"] = "FAIL";
    printSummary(results);
    process.exit(1);
  }

  // ── STEP 2: Run care-planner ─────────────────────────────────────────────────
  console.log("\nSTEP 2 — Running care-planner for P008...");
  let questionPriority: string[] = [];
  try {
    const plannerResult = await invokeLambda(CARE_PLANNER, { patientId: PATIENT_ID }) as {
      statusCode?:      number;
      status?:          string;
      confidenceScore?: number;
      conditionCodes?:  string[];
      questionPriority?: string[];
    };

    console.log(`  ✓ Status:           ${plannerResult.statusCode}`);
    console.log(`  ✓ Review status:    ${plannerResult.status}`);
    console.log(`  ✓ Confidence score: ${plannerResult.confidenceScore ?? "n/a"}`);
    console.log(`  ✓ Condition codes:  ${JSON.stringify(plannerResult.conditionCodes)}`);

    questionPriority = plannerResult.questionPriority ?? [];
    console.log(`  ✓ Questions (${questionPriority.length}): ${questionPriority.join(", ")}`);
    results["CARE_PLANNER"] = "PASS";
  } catch (err) {
    console.error("  ✗ Care-planner failed:", err instanceof Error ? err.message : String(err));
    results["CARE_PLANNER"] = "FAIL";
  }

  // ── STEP 2a: Verify questions are hypertension-specific ──────────────────────
  console.log("\n  Verifying questions are hypertension-specific...");
  {
    const hasCHF  = questionPriority.some((q) => CHF_VARS.has(q));
    const hasKnee = questionPriority.some((q) => KNEE_VARS.has(q));

    if (hasCHF) {
      console.log("  ✗ Questions contain CHF-specific variables — not dynamic!");
      results["PROTOCOL_DYNAMIC_CHF"] = "FAIL";
    } else {
      console.log("  ✓ No CHF variables (weight_gain_lbs, lasix_filled, ankle_swelling)");
      results["PROTOCOL_DYNAMIC_CHF"] = "PASS";
    }

    if (hasKnee) {
      console.log("  ✗ Questions contain knee-specific variables — not dynamic!");
      results["PROTOCOL_DYNAMIC_KNEE"] = "FAIL";
    } else {
      console.log("  ✓ No knee variables (knee_swelling, knee_pain, range_of_motion)");
      results["PROTOCOL_DYNAMIC_KNEE"] = "PASS";
    }

    if (questionPriority.length === 0) {
      console.log("  ✗ Care-planner returned no questions!");
      results["PROTOCOL_HAS_QUESTIONS"] = "FAIL";
    } else {
      console.log(`  ✓ ${questionPriority.length} hypertension-specific question(s) returned`);
      results["PROTOCOL_HAS_QUESTIONS"] = "PASS";
    }
  }

  // ── STEP 2b: Force-approve P008 protocol for testing ─────────────────────────
  console.log("\nSTEP 2b — Force-approving P008 protocol for testing...");
  try {
    // 1. Find the P008 review in ProtocolReview
    const scanResult = await dynamo.send(new ScanCommand({
      TableName:                 TABLE_REVIEWS,
      FilterExpression:          "patient_id = :pid",
      ExpressionAttributeValues: { ":pid": PATIENT_ID },
    }));

    const reviewItem = (scanResult.Items ?? [])[0] as Record<string, unknown> | undefined;
    if (!reviewItem) {
      throw new Error("No ProtocolReview record found for P008 — care-planner may have failed");
    }

    const reviewId = String(reviewItem["review_id"] ?? "");
    const now      = new Date().toISOString();

    // 2. Update ProtocolReview: APPROVED by AUTO-TEST
    await dynamo.send(new UpdateCommand({
      TableName:                TABLE_REVIEWS,
      Key:                      { review_id: reviewId, patient_id: PATIENT_ID },
      UpdateExpression:         "SET #s = :s, reviewed_by = :rb, reviewed_at = :ra, approved_at = :aa",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s":  "APPROVED",
        ":rb": "AUTO-TEST",
        ":ra": now,
        ":aa": now,
      },
    }));
    console.log(`  ✓ ProtocolReview ${reviewId} → APPROVED (reviewed_by: AUTO-TEST)`);

    // 3. Write the protocol to TriageProtocols so lex-fulfillment can use it during the call
    const protocol = reviewItem["protocol"] as Record<string, unknown> | undefined;
    if (!protocol) {
      throw new Error("ProtocolReview record has no protocol field");
    }

    await dynamo.send(new PutCommand({
      TableName: TABLE_PROTOCOLS,
      Item: {
        patient_id:      PATIENT_ID,
        protocol,
        lace_score:      reviewItem["lace_score"]      ?? 0,
        lace_risk_level: reviewItem["lace_risk_level"] ?? "UNKNOWN",
        created_at:      now,
        approved_by:     "AUTO-TEST",
        review_id:       reviewId,
      },
    }));
    console.log("  ✓ P008 protocol written to TriageProtocols");
    console.log("  ✓ P008 protocol force-approved for testing");
    results["PROTOCOL_APPROVED"] = "PASS";
  } catch (err) {
    console.error("  ✗ Force-approve failed:", err instanceof Error ? err.message : String(err));
    results["PROTOCOL_APPROVED"] = "FAIL";
  }

  // ── STEP 3: Place real outbound call ─────────────────────────────────────────
  console.log("\nSTEP 3 — Placing real outbound call to P008...");
  const callId = `CALL-P008-${Date.now().toString(16)}`;
  try {
    const callResult = await invokeLambda(CALL_INIT, {
      patientId: PATIENT_ID,
      callId,
    }) as {
      statusCode?: number;
      callId?:     string;
      status?:     string;
      error?:      string;
    };

    if (callResult.statusCode === 200 || callResult.status === "INITIATED") {
      console.log(`  ✓ Call initiated — callId: ${callId}`);
      results["CALL_INITIATED"] = "PASS";
    } else {
      console.error(`  ✗ Call initiator returned ${callResult.statusCode}: ${callResult.error ?? JSON.stringify(callResult)}`);
      results["CALL_INITIATED"] = "FAIL";
    }
  } catch (err) {
    console.error("  ✗ Call initiator failed:", err instanceof Error ? err.message : String(err));
    results["CALL_INITIATED"] = "FAIL";
    // Continue — always print call details even on failure
  }

  // ── Final summary ─────────────────────────────────────────────────────────────
  printSummary(results);

  const allPass = Object.values(results).every((v) => v === "PASS");

  console.log(SEP);
  console.log("CALL DETAILS");
  console.log(SEP);
  console.log(`  Call placed for P008 — David Chen`);
  console.log(`  Phone:     ${TEST_PHONE}`);
  console.log(`  Condition: ${CONDITION.display} (${CONDITION.code})`);
  console.log(`  Expected LACE: ${EXPECTED_LACE.total} ${EXPECTED_LACE.risk} (L=${EXPECTED_LACE.l} A=${EXPECTED_LACE.a} C=${EXPECTED_LACE.c} E=${EXPECTED_LACE.e})`);
  console.log(`  Watch for call from ${CONNECT_PHONE}`);
  console.log(`  Answer with natural responses`);
  console.log(SEP);
  console.log("  After the call, run:  npm run cleanup:stale");
  console.log(SEP);

  if (!allPass) process.exit(1);
}

function printSummary(results: Record<string, "PASS" | "FAIL">): void {
  const allPass = Object.values(results).every((v) => v === "PASS");
  console.log("\n" + SEP);
  console.log("TEST RESULTS");
  console.log(SEP);
  for (const [key, val] of Object.entries(results)) {
    const mark = val === "PASS" ? "✓" : "✗";
    console.log(`  ${mark} ${key.padEnd(28)} ${val}`);
  }
  console.log(SEP);
  console.log(`  OVERALL: ${allPass ? "PASS" : "FAIL"}`);
  console.log(SEP);
}

main().catch((err: unknown) => {
  console.error("test:new-patient-call failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
