import * as dotenv from "dotenv";
import * as path from "path";
import {
  DynamoDBClient,
  ScanCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { getFullPatientRecord, getEncounters } from "./fhir/fhir-client";
import { getRulesForCondition } from "./rules/clinical-rules-client";
import { calculateLaceScore } from "@sentinel/lace";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const PATIENT_IDS = ["P001", "P002", "P003", "P004", "P005", "P006"];
const RULE_CODES = ["I50.9", "Z96.651", "E11.9", "J18.9", "I21.9", "N18.3"];

function makeClient(): DynamoDBClient {
  return new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"]
      ? { endpoint: process.env["DYNAMO_ENDPOINT"] }
      : {}),
  });
}

function fhirBase(): string {
  return process.env["FHIR_BASE_URL"] ?? "http://localhost:8080/fhir";
}

// ─── Check 1: FHIR patients ───────────────────────────────────────────────────

async function checkFhirPatients(): Promise<number> {
  let found = 0;
  for (const pid of PATIENT_IDS) {
    try {
      const res = await fetch(`${fhirBase()}/Patient/${pid}`);
      if (res.ok) found++;
    } catch {
      // unreachable server — count as 0
    }
  }
  return found;
}

// ─── Check 2: FHIR conditions ─────────────────────────────────────────────────

async function checkFhirConditions(): Promise<number> {
  let found = 0;
  for (const pid of PATIENT_IDS) {
    try {
      const res = await fetch(`${fhirBase()}/Condition?patient=${pid}`);
      if (res.ok) {
        const bundle = (await res.json()) as { entry?: unknown[] };
        if ((bundle.entry ?? []).length > 0) found++;
      }
    } catch {
      // skip
    }
  }
  return found;
}

// ─── Check 3: FHIR medications ────────────────────────────────────────────────

async function checkFhirMedications(): Promise<number> {
  let found = 0;
  for (const pid of PATIENT_IDS) {
    try {
      const res = await fetch(
        `${fhirBase()}/MedicationRequest?patient=${pid}`
      );
      if (res.ok) {
        const bundle = (await res.json()) as { entry?: unknown[] };
        if ((bundle.entry ?? []).length > 0) found++;
      }
    } catch {
      // skip
    }
  }
  return found;
}

// ─── Check 4: Clinical rules ──────────────────────────────────────────────────

async function checkClinicalRules(
  client: DynamoDBClient
): Promise<{ count: number; missing: string[] }> {
  const rulesTable = process.env["DYNAMO_TABLE_RULES"] ?? "ClinicalRules";
  const missing: string[] = [];

  for (const code of RULE_CODES) {
    const res = await client.send(
      new GetItemCommand({
        TableName: rulesTable,
        Key: marshall({ condition_code: code }),
      })
    );
    if (!res.Item) missing.push(code);
  }

  return { count: RULE_CODES.length - missing.length, missing };
}

// ─── Check 5: Rule completeness ───────────────────────────────────────────────

async function checkRuleCompleteness(client: DynamoDBClient): Promise<string[]> {
  const rulesTable = process.env["DYNAMO_TABLE_RULES"] ?? "ClinicalRules";
  const incomplete: string[] = [];

  for (const code of RULE_CODES) {
    const res = await client.send(
      new GetItemCommand({
        TableName: rulesTable,
        Key: marshall({ condition_code: code }),
      })
    );
    if (res.Item) {
      const rule = unmarshall(res.Item) as { conditions?: unknown[] };
      if ((rule.conditions ?? []).length < 5) incomplete.push(code);
    }
  }

  return incomplete;
}

// ─── Check 6: Demo call results ───────────────────────────────────────────────

async function checkDemoResults(client: DynamoDBClient): Promise<{
  count: number;
  distribution: Record<string, number>;
}> {
  const resultsTable = process.env["DYNAMO_TABLE_RESULTS"] ?? "CallResults";
  const res = await client.send(
    new ScanCommand({ TableName: resultsTable })
  );

  const items = (res.Items ?? []).map(
    (i) => unmarshall(i) as { triage_status?: string }
  );
  const distribution: Record<string, number> = {
    RED: 0,
    YELLOW: 0,
    GREEN: 0,
    INCOMPLETE: 0,
  };

  for (const item of items) {
    const status = item.triage_status ?? "UNKNOWN";
    if (status in distribution) {
      distribution[status] = (distribution[status] ?? 0) + 1;
    }
  }

  return { count: items.length, distribution };
}

// ─── Check 7: Protocol reviews ────────────────────────────────────────────────

async function checkProtocolReviews(client: DynamoDBClient): Promise<{
  count: number;
  autoApproved: number;
  pending: number;
}> {
  const reviewsTable = process.env["DYNAMO_TABLE_REVIEWS"] ?? "ProtocolReview";
  const res = await client.send(
    new ScanCommand({ TableName: reviewsTable })
  );

  const items = (res.Items ?? []).map(
    (i) => unmarshall(i) as { status?: string }
  );
  const autoApproved = items.filter((i) => i.status === "AUTO_APPROVED").length;
  const pending = items.filter((i) => i.status === "PENDING_REVIEW").length;

  return { count: items.length, autoApproved, pending };
}

// ─── Check 8: FHIR client smoke test ─────────────────────────────────────────

async function checkFhirClient(): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    const record = await getFullPatientRecord("P001");
    if (record.patient && record.conditions && record.medications) {
      return { ok: true, message: "WORKING" };
    }
    return { ok: false, message: "ERROR — missing fields in response" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `ERROR — ${msg}` };
  }
}

// ─── Check 9: Rules client smoke test ────────────────────────────────────────

async function checkRulesClient(): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    const rule = await getRulesForCondition("I50.9");
    if (rule !== null) {
      return { ok: true, message: "WORKING" };
    }
    return { ok: false, message: "ERROR — returned null for I50.9" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `ERROR — ${msg}` };
  }
}

// ─── Check 10: FHIR encounters ───────────────────────────────────────────────

async function checkFhirEncounters(): Promise<number> {
  let found = 0;
  for (const pid of PATIENT_IDS) {
    try {
      const res = await fetch(`${fhirBase()}/Encounter?patient=${pid}`);
      if (res.ok) {
        const bundle = (await res.json()) as { entry?: unknown[] };
        if ((bundle.entry ?? []).length > 0) found++;
      }
    } catch {
      // skip
    }
  }
  return found;
}

// ─── Check 11: LACE calculator smoke test ────────────────────────────────────

function checkLaceCalculator(): { ok: boolean; message: string } {
  try {
    const result = calculateLaceScore({
      admissionDate: "2026-02-28",
      dischargeDate: "2026-03-06",
      admissionType: "EMERGENCY",
      conditionCodes: ["I50.9"],
      recentEDVisits: 2,
    });
    // 6 days LOS → L=4, EMERGENCY → A=3, I50.9 charlson=1 → C=1, 2 ED → E=2 → total=10
    if (result.totalScore === 10 && result.riskLevel === "HIGH") {
      return { ok: true, message: "WORKING" };
    }
    return {
      ok: false,
      message: `ERROR — expected score=10 HIGH, got score=${result.totalScore} ${result.riskLevel}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `ERROR — ${msg}` };
  }
}

// ─── Check 12: getEncounters client smoke test ────────────────────────────────

async function checkGetEncounters(): Promise<{ ok: boolean; message: string }> {
  try {
    const encounters = await getEncounters("P001");
    if (encounters.length >= 3) {
      return { ok: true, message: "WORKING" };
    }
    return {
      ok: false,
      message: `ERROR — expected ≥3 encounters for P001, got ${encounters.length}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `ERROR — ${msg}` };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const client = makeClient();

  console.log("Running verification...\n");

  const [
    patientCount,
    conditionCount,
    medicationCount,
    rulesResult,
    incompleteRules,
    resultsResult,
    reviewsResult,
    fhirClientResult,
    rulesClientResult,
    encounterCount,
    getEncountersResult,
  ] = await Promise.all([
    checkFhirPatients(),
    checkFhirConditions(),
    checkFhirMedications(),
    checkClinicalRules(client),
    checkRuleCompleteness(client),
    checkDemoResults(client),
    checkProtocolReviews(client),
    checkFhirClient(),
    checkRulesClient(),
    checkFhirEncounters(),
    checkGetEncounters(),
  ]);

  const laceResult = checkLaceCalculator();

  const dist = resultsResult.distribution;

  // Rule completeness line
  const rulesCompleteStr =
    incompleteRules.length === 0
      ? "all rules complete"
      : `incomplete: ${incompleteRules.join(", ")}`;

  // Distribution line
  const distStr = `RED:${dist["RED"] ?? 0} YELLOW:${dist["YELLOW"] ?? 0} GREEN:${dist["GREEN"] ?? 0} INCOMPLETE:${dist["INCOMPLETE"] ?? 0}`;

  const allOk =
    patientCount === 6 &&
    conditionCount === 6 &&
    medicationCount === 6 &&
    rulesResult.count === 6 &&
    incompleteRules.length === 0 &&
    resultsResult.count === 6 &&
    reviewsResult.count >= 2 &&
    reviewsResult.autoApproved === 1 &&
    reviewsResult.pending === 1 &&
    fhirClientResult.ok &&
    rulesClientResult.ok &&
    encounterCount === 6 &&
    laceResult.ok &&
    getEncountersResult.ok;

  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  );
  console.log("SECTION 2 — VERIFICATION REPORT");
  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  );
  console.log(`FHIR patients:           ${patientCount}/6`);
  console.log(`FHIR conditions:         ${conditionCount}/6`);
  console.log(`FHIR medications:        ${medicationCount}/6`);
  console.log(`Clinical rules:          ${rulesResult.count}/6`);
  console.log(`Rule completeness:       ${rulesCompleteStr}`);
  console.log(
    `Demo call results:       ${resultsResult.count}/6 (${distStr})`
  );
  console.log(
    `Protocol reviews:        ${reviewsResult.count}/2 (AUTO_APPROVED:${reviewsResult.autoApproved} PENDING_REVIEW:${reviewsResult.pending})`
  );
  console.log(`FHIR client:             ${fhirClientResult.message}`);
  console.log(`Rules client:            ${rulesClientResult.message}`);
  console.log(`FHIR encounters:         ${encounterCount}/6`);
  console.log(`LACE calculator:         ${laceResult.message}`);
  console.log(`getEncounters client:    ${getEncountersResult.message}`);
  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  );
  console.log(`OVERALL: ${allOk ? "SECTION 2 COMPLETE" : "ACTION REQUIRED"}`);
  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  );

  if (!allOk) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("verify failed:", err);
  process.exit(1);
});
