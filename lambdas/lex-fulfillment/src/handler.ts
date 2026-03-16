/**
 * lex-fulfillment/handler.ts — Dialog code hook for SentinelVoiceBot.
 *
 * Called by Lex v2 on every conversation turn. Drives the patient
 * follow-up conversation by reading the care protocol from DynamoDB,
 * formatting each question for natural speech, extracting answers via
 * Nova Lite, and persisting answers to CallResults.
 *
 * Session attribute state (all strings — Lex requirement):
 *   initialized       "true" once protocol + patient info are loaded
 *   patientId         set by Connect before the Lex block starts
 *   callId            set by Connect before the Lex block starts
 *   nextQuestionIdx   index of the NEXT question to ask (starts at 0)
 *   answersJson       JSON map of variable → raw extracted answer
 *   questionsAsked    running count for logging
 *   protocolJson      cached Protocol object
 *   patientInfoJson   cached PatientInfo object
 */

import { DynamoDBClient }                              from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand,
         PutCommand, UpdateCommand }                    from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand }    from "@aws-sdk/client-bedrock-runtime";
import { formatQuestion, QuestionContext }              from "../../nova-sonic-handler/src/question-formatter";

// ─── DynamoDB protocol types ──────────────────────────────────────────────────

interface ProtocolCondition {
  variable:   string;
  operator:   string;
  threshold:  number | boolean;
  weight:     number;
  flag_color: string;
}

interface Protocol {
  flag_color:         string;
  question_priority:  string[];
  patient_id:         string;
  preferred_language: string;
  root_node: {
    conditions: ProtocolCondition[];
  };
}

// ─── Patient info fetched from FHIR ──────────────────────────────────────────

interface PatientInfo {
  patientName:      string;
  conditionCode:    string;
  conditionDisplay: string;
  medications:      string[];
}

// ─── Lex v2 event / response shapes ──────────────────────────────────────────

interface LexSlotValue {
  value?: {
    originalValue?:    string;
    interpretedValue?: string;
  };
}

interface LexEvent {
  messageVersion:  string;
  invocationSource: string;
  inputTranscript?: string;
  sessionState: {
    sessionAttributes?: Record<string, string>;
    intent: {
      name:   string;
      state?: string;
      slots?: Record<string, LexSlotValue | null | undefined>;
    };
  };
  bot: { id: string; name: string };
}

interface LexResponse {
  sessionState: {
    sessionAttributes: Record<string, string>;
    dialogAction:
      | { type: "ElicitSlot"; slotToElicit: string }
      | { type: "Close" };
    intent: {
      name:   string;
      state:  "InProgress" | "Fulfilled";
      slots?: Record<string, null>;
    };
  };
  messages: Array<{ contentType: "PlainText" | "SSML"; content: string }>;
}

interface ExtractionResult {
  value:      string;  // "true", "false", a number string, or "unknown"
  confidence: number;  // 0.0 – 1.0
}

// ─── AWS clients ──────────────────────────────────────────────────────────────

const REGION             = process.env["AWS_REGION"]              ?? "us-east-1";
const PROTOCOLS_TABLE    = process.env["DYNAMO_TABLE_PROTOCOLS"]  ?? "TriageProtocols";
const RESULTS_TABLE      = process.env["DYNAMO_TABLE_RESULTS"]    ?? "CallResults";
const PROFILES_TABLE     = process.env["DYNAMO_TABLE_PATIENTS"]   ?? "PatientProfiles";
const FHIR_BASE_URL      = process.env["FHIR_BASE_URL"]           ?? "";
const NOVA_LITE_MODEL    = process.env["BEDROCK_MODEL_EXTRACTOR"] ?? "amazon.nova-lite-v1:0";
const TRIAGE_ENGINE_ARN  = process.env["LAMBDA_ARN_TRIAGE_ENGINE"] ?? "";
const SUMMARIZER_ARN     = process.env["LAMBDA_ARN_SUMMARIZER"]    ?? "";

const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const bedrock = new BedrockRuntimeClient({ region: REGION });

// ─── DynamoDB helpers ─────────────────────────────────────────────────────────

async function loadProtocol(patientId: string): Promise<Protocol> {
  const resp = await dynamo.send(new GetCommand({
    TableName: PROTOCOLS_TABLE,
    Key:       { patient_id: patientId },
  }));
  if (!resp.Item) throw new Error(`No protocol for patient ${patientId}`);
  return resp.Item["protocol"] as Protocol;
}

async function ensureResultRecord(
  patientId: string,
  callId:    string,
  opts?: { conditionCode?: string; patientName?: string },
): Promise<void> {
  try {
    await dynamo.send(new PutCommand({
      TableName:           RESULTS_TABLE,
      ConditionExpression: "attribute_not_exists(call_id)",
      Item: {
        call_id:              callId,
        patient_id:           patientId,
        call_status:          "IN_PROGRESS",
        call_timestamp:       new Date().toISOString(),
        variables:            {},
        unresolved_variables: [],
        transcript_warnings:  [],
        nurse_acknowledged:   false,
        ...(opts?.conditionCode && { condition_code: opts.conditionCode }),
        ...(opts?.patientName   && { patient_name:   opts.patientName }),
      },
    }));
  } catch (err: unknown) {
    // ConditionalCheckFailedException → record already exists, that's fine
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
  }
}

async function writeAnswer(
  patientId:  string,
  callId:     string,
  variable:   string,
  value:      number | boolean | string,
  confidence: number,
  opts?: { conditionCode?: string; patientName?: string },
): Promise<void> {
  await ensureResultRecord(patientId, callId, opts);
  await dynamo.send(new UpdateCommand({
    TableName:                RESULTS_TABLE,
    Key:                      { call_id: callId, patient_id: patientId },
    UpdateExpression:         "SET variables.#var = :val, updated_at = :u",
    ExpressionAttributeNames: { "#var": variable },
    ExpressionAttributeValues: {
      ":val": { value, confidence },
      ":u":   new Date().toISOString(),
    },
  }));
}

async function markComplete(patientId: string, callId: string): Promise<void> {
  await dynamo.send(new UpdateCommand({
    TableName:        RESULTS_TABLE,
    Key:              { call_id: callId, patient_id: patientId },
    UpdateExpression: "SET call_status = :s, completed_at = :c, updated_at = :u",
    ExpressionAttributeValues: {
      ":s": "COMPLETE",
      ":c": new Date().toISOString(),
      ":u": new Date().toISOString(),
    },
  }));
}

async function markUnresolved(patientId: string, callId: string, variable: string): Promise<void> {
  await ensureResultRecord(patientId, callId);
  await dynamo.send(new UpdateCommand({
    TableName:        RESULTS_TABLE,
    Key:              { call_id: callId, patient_id: patientId },
    UpdateExpression: "SET unresolved_variables = list_append(if_not_exists(unresolved_variables, :empty), :var), updated_at = :u",
    ExpressionAttributeValues: {
      ":empty": [],
      ":var":   [variable],
      ":u":     new Date().toISOString(),
    },
  }));
}

async function fireDownstream(patientId: string, callId: string, answers: Record<string, string>): Promise<void> {
  const { LambdaClient: LC, InvokeCommand: IC } = await import("@aws-sdk/client-lambda");
  const lc = new LC({ region: REGION });

  console.log("[CALL COMPLETE] patientId:", patientId);
  console.log("[CALL COMPLETE] callId:", callId);
  console.log("[CALL COMPLETE] answers:", JSON.stringify(answers));
  console.log("[CALL COMPLETE] triggering triage synchronously...");

  // Invoke triage SYNCHRONOUSLY so summarizer gets a completed result — no race condition.
  let triageData: {
    triageStatus?: string;
    brokenRules?: string[];
    weightedScore?: number;
    laceScore?: number;
    laceRiskLevel?: string;
  } = {};

  if (TRIAGE_ENGINE_ARN) {
    try {
      const triageInput = Buffer.from(JSON.stringify({ patientId, callId }));
      const triageResp = await lc.send(new IC({
        FunctionName:    TRIAGE_ENGINE_ARN,
        InvocationType: "RequestResponse",
        Payload:         triageInput,
      }));
      if (triageResp.Payload) {
        const result = JSON.parse(Buffer.from(triageResp.Payload).toString("utf-8")) as {
          triageStatus?: string;
          brokenRules?:  string[];
          weightedScore?: number;
          laceScore?:     number;
          laceRiskLevel?: string;
        };
        triageData = {
          ...(result.triageStatus !== undefined && { triageStatus: result.triageStatus }),
          brokenRules:   result.brokenRules   ?? [],
          weightedScore: result.weightedScore ?? 0,
          laceScore:     result.laceScore     ?? 0,
          laceRiskLevel: result.laceRiskLevel ?? "UNKNOWN",
        };
        console.log("[CALL COMPLETE] triage result:", JSON.stringify(triageData));
      }
    } catch (err) {
      console.error("[CALL COMPLETE] triage-engine synchronous invocation failed:", err);
    }
    console.log("[CALL COMPLETE] triage-engine done →", TRIAGE_ENGINE_ARN);
  } else {
    console.warn("[CALL COMPLETE] LAMBDA_ARN_TRIAGE_ENGINE not set — triage skipped");
  }

  // Invoke summarizer async — pass triage result + captured variables directly to avoid
  // a second race condition where summarizer reads DynamoDB before triage writes finish.
  if (SUMMARIZER_ARN) {
    const summarizerPayload = Buffer.from(JSON.stringify({
      patientId,
      callId,
      ...triageData,
      variables: answers,
    }));
    await lc.send(new IC({ FunctionName: SUMMARIZER_ARN, InvocationType: "Event", Payload: summarizerPayload }));
    console.log("[CALL COMPLETE] summarizer fired →", SUMMARIZER_ARN);
  } else {
    console.warn("[CALL COMPLETE] LAMBDA_ARN_SUMMARIZER not set — summarizer skipped");
  }
}

// ─── FHIR patient info ────────────────────────────────────────────────────────

async function loadPatientInfo(patientId: string): Promise<PatientInfo> {
  const fallback: PatientInfo = {
    patientName:      "",
    conditionCode:    "",
    conditionDisplay: "",
    medications:      [],
  };

  // ── Primary: PatientProfiles DynamoDB (~5ms vs ~200ms for FHIR) ──────────
  // hydrate-lace writes patient_name, condition_code, condition_display here.
  try {
    const profileResp = await dynamo.send(new GetCommand({
      TableName: PROFILES_TABLE,
      Key:       { patient_id: patientId },
    }));
    if (profileResp.Item) {
      const item = profileResp.Item as Record<string, unknown>;
      const patientName      = (item["patient_name"]      as string | undefined) ?? "";
      const conditionCode    = (item["condition_code"]    as string | undefined) ?? "";
      const conditionDisplay = (item["condition_display"] as string | undefined) ?? conditionCode;
      // PatientProfiles doesn't store medications — load from FHIR if URL is available
      const medications = await loadMedicationsFromFhir(patientId);
      return { patientName, conditionCode, conditionDisplay, medications };
    }
  } catch {
    // PatientProfiles unavailable — fall through to FHIR
  }

  // ── Fallback: FHIR (for new patients not yet hydrated) ───────────────────
  if (!FHIR_BASE_URL) return fallback;

  try {
    // Parallel FHIR calls — Patient + MedicationRequests + Conditions simultaneously
    const [patRes, medRes, condRes] = await Promise.all([
      fetch(`${FHIR_BASE_URL}/Patient/${patientId}`,
        { signal: AbortSignal.timeout(4_000) }),
      fetch(`${FHIR_BASE_URL}/MedicationRequest?patient=${patientId}&status=active`,
        { signal: AbortSignal.timeout(4_000) }),
      fetch(`${FHIR_BASE_URL}/Condition?patient=${patientId}&_elements=code`,
        { signal: AbortSignal.timeout(4_000) }),
    ]);

    if (!patRes.ok) return fallback;

    const patient = await patRes.json() as {
      name?: Array<{ given?: string[]; family?: string }>;
    };
    const given  = patient.name?.[0]?.given?.[0]  ?? "";
    const family = patient.name?.[0]?.family ?? "";
    const patientName = [given, family].filter(Boolean).join(" ");

    const medications: string[] = [];
    if (medRes.ok) {
      const bundle = await medRes.json() as {
        entry?: Array<{
          resource?: {
            medicationCodeableConcept?: {
              coding?: Array<{ display?: string }>;
            };
          };
        }>;
      };
      for (const entry of bundle.entry ?? []) {
        const display = entry.resource?.medicationCodeableConcept?.coding?.[0]?.display;
        if (display) medications.push(display);
      }
    }

    // Extract primary condition code + display for writing to CallResults
    let conditionCode    = "";
    let conditionDisplay = "";
    if (condRes.ok) {
      const condBundle = await condRes.json() as {
        entry?: Array<{
          resource?: {
            code?: { coding?: Array<{ code?: string; display?: string }>; text?: string };
          };
        }>;
      };
      const firstCond = condBundle.entry?.[0]?.resource;
      conditionCode    = firstCond?.code?.coding?.[0]?.code    ?? "";
      conditionDisplay = firstCond?.code?.coding?.[0]?.display
                      ?? firstCond?.code?.text
                      ?? conditionCode;
    }

    return { patientName, conditionCode, conditionDisplay, medications };
  } catch {
    return fallback;
  }
}

async function loadMedicationsFromFhir(patientId: string): Promise<string[]> {
  if (!FHIR_BASE_URL) return [];
  try {
    const res = await fetch(
      `${FHIR_BASE_URL}/MedicationRequest?patient=${patientId}&status=active`,
      { signal: AbortSignal.timeout(3_000) },
    );
    if (!res.ok) return [];
    const bundle = await res.json() as {
      entry?: Array<{
        resource?: {
          medicationCodeableConcept?: { coding?: Array<{ display?: string }> };
        };
      }>;
    };
    const meds: string[] = [];
    for (const entry of bundle.entry ?? []) {
      const display = entry.resource?.medicationCodeableConcept?.coding?.[0]?.display;
      if (display) meds.push(display);
    }
    return meds;
  } catch {
    return [];
  }
}

// ─── Bedrock answer extraction ────────────────────────────────────────────────

const BOOLEAN_VARS = new Set([
  "shortness_of_breath", "lasix_filled", "fever", "antibiotic_taken",
  "chest_pain", "medication_adherence", "confusion", "mobility",
  "appetite", "dizziness", "swelling", "ankle_swelling", "wound_drainage",
  "steroid_taken", "sputum_colour",
]);

const NUMERIC_VARS = new Set([
  "weight_gain_lbs", "blood_sugar_level", "pain_level",
  "oxygen_saturation", "rescue_inhaler_use", "blood_pressure",
]);

// Plausible clinical ranges for numeric variables — values outside these are flagged
const NUMERIC_RANGES: Record<string, [number, number]> = {
  blood_pressure:    [60, 250],
  weight_gain_lbs:   [0,  50],
  pain_level:        [0,  10],
  oxygen_saturation: [70, 100],
  blood_sugar_level: [40, 600],
  rescue_inhaler_use:[0,  20],
};

async function extractAnswer(
  transcript:   string,
  variable:     string,
  questionText: string,
): Promise<ExtractionResult> {
  // Guard: single-word yes/no responses for numeric variables are meaningless.
  // Word-spelled numbers ("four", "seven") ARE valid — pass to LLM.
  // Only block unambiguously non-numeric words.
  if (NUMERIC_VARS.has(variable) && transcript.trim().split(/\s+/).length === 1) {
    const word = transcript.trim().toLowerCase().replace(/[.?!,]+$/, "");
    const nonNumericWords = /^(yes|no|yeah|nope|ok|okay|sure|fine|good|bad|maybe|dunno|nothing|none|never|always|idk)$/;
    if (nonNumericWords.test(word)) {
      console.log(`[lex-fulfillment] Non-numeric single word for ${variable} ("${transcript}") — marking unresolved`);
      return { value: "unknown", confidence: 0.0 };
    }
  }

  let semanticRules: string;
  let formatHint:    string;

  if (BOOLEAN_VARS.has(variable)) {
    formatHint    = '"value" must be a JSON boolean: true or false (not a string).';
    semanticRules =
      `- true  = patient CONFIRMS they have/are experiencing this\n` +
      `- false = patient DENIES it (e.g. "no", "no I don't", "I feel fine", "not at all", "none", "not really")\n` +
      `- If patient rambles but says "no" somewhere relevant → false\n` +
      `- If patient rambles but says "yes" somewhere relevant → true\n` +
      `- Extract ONLY the core yes/no — ignore irrelevant context`;
  } else if (NUMERIC_VARS.has(variable)) {
    formatHint    = '"value" must be a JSON number (e.g. 4 or 2.5). Use 0 if patient says "no" or "none".';
    semanticRules =
      `- Extract only the number the patient stated\n` +
      `- "about four" → 4, "three or four" → 3.5, "nothing" → 0\n` +
      `- Ignore units and surrounding context`;
  } else {
    formatHint    = '"value" must be a JSON boolean or number.';
    semanticRules = `- true = patient says YES, false = patient says NO`;
  }

  const prompt =
    `You are a precise medical data extractor. A patient is on a post-discharge follow-up call.\n` +
    `Extract ONLY the specific answer to the medical question. Ignore irrelevant context or off-topic speech.\n\n` +
    `Medical question asked: "${questionText}"\n` +
    `Clinical variable: "${variable}"\n` +
    `Patient's full response: "${transcript}"\n\n` +
    `Extraction rules:\n` +
    `${semanticRules}\n` +
    `- If the response is completely unclear or patient refuses to answer → use the string "unknown"\n\n` +
    `${formatHint}\n\n` +
    `confidence scoring:\n` +
    `- 0.9–1.0: clear, direct answer\n` +
    `- 0.7–0.9: answer present but with context\n` +
    `- 0.5–0.7: somewhat ambiguous\n` +
    `- 0.0–0.5: very unclear or indeterminate\n\n` +
    `Respond with ONLY valid JSON — no markdown, no explanation:\n` +
    `{"value": <true|false|number|"unknown">, "confidence": <0.0-1.0>}`;

  try {
    const body = {
      messages:        [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 64, temperature: 0.0 },
    };

    const resp = await bedrock.send(new InvokeModelCommand({
      modelId:     NOVA_LITE_MODEL,
      contentType: "application/json",
      accept:      "application/json",
      body:        new TextEncoder().encode(JSON.stringify(body)),
    }));

    const raw = (JSON.parse(new TextDecoder().decode(resp.body)) as {
      output?: { message?: { content?: Array<{ text?: string }> } };
    }).output?.message?.content?.[0]?.text?.trim() ?? "";

    // Strip optional markdown fences
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

    try {
      const parsed = JSON.parse(jsonStr) as { value: unknown; confidence: unknown };
      const rawVal = parsed.value;
      const value  =
        typeof rawVal === "boolean" ? String(rawVal)  :
        typeof rawVal === "number"  ? String(rawVal)  :
        typeof rawVal === "string"  ? rawVal.toLowerCase() :
        "unknown";
      let confidence =
        typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5;

      // Guard: plausible range check for numeric variables
      if (NUMERIC_VARS.has(variable) && value !== "unknown") {
        const range = NUMERIC_RANGES[variable];
        if (range) {
          const n = Number(value);
          if (!isNaN(n) && (n < range[0] || n > range[1])) {
            console.log(`[lex-fulfillment] ${variable}=${n} outside plausible range [${range[0]},${range[1]}] — capping confidence to 0.3`);
            confidence = Math.min(confidence, 0.3);
          }
        }
      }

      return { value, confidence };
    } catch {
      // JSON parse failed — fall back to plain-text extraction
      const plain = jsonStr.toLowerCase();
      if (plain === "true" || plain === "false") return { value: plain, confidence: 0.7 };
      const n = Number(plain);
      if (!isNaN(n) && plain !== "") return { value: plain, confidence: 0.7 };
      return { value: "unknown", confidence: 0 };
    }
  } catch (err) {
    console.error("[lex-fulfillment] Bedrock extraction failed:", err);
    return { value: "unknown", confidence: 0 };
  }
}

function parseExtracted(raw: string): number | boolean | string {
  if (raw === "true")  return true;
  if (raw === "false") return false;
  const n = Number(raw);
  if (!isNaN(n) && raw !== "") return n;
  return raw;
}

// ─── Acknowledgement prefix (A4) ─────────────────────────────────────────────
// Uses the protocol rule's threshold direction to determine clinical meaning:
//   threshold === true  → rule fires when symptom IS present → value=true is concerning
//   threshold === false → rule fires when NOT adherent      → value=true is reassuring
// This works for ANY condition without hardcoding variable names.

function getAckPrefix(
  variable:  string,
  value:     string,
  confidence: number,
  protocol:  Protocol,
): string {
  if (confidence < 0.5) return "Thank you. ";

  const rule = protocol.root_node?.conditions?.find(c => c.variable === variable);

  // Boolean variables — use protocol rule threshold to determine clinical direction
  if (BOOLEAN_VARS.has(variable) || (rule && typeof rule.threshold === "boolean")) {
    const parsedValue = value === "true";
    // If the rule threshold is `true`, the rule fires (flags concern) when value IS true → symptom type
    // If the rule threshold is `false`, the rule fires when value IS false → adherence type
    const ruleFiresOnTrue = !rule || rule.threshold === true;
    const isConcerning = ruleFiresOnTrue ? parsedValue : !parsedValue;
    return isConcerning ? "I understand, I've noted that. " : "Good to hear. ";
  }

  // Numeric variables — compare extracted value against protocol threshold
  if (NUMERIC_VARS.has(variable)) {
    const n = parseFloat(value);
    if (!isNaN(n)) {
      if (rule) {
        const threshold = Number(rule.threshold);
        const op = rule.operator;
        const isExceeded =
          op === ">=" ? n >= threshold :
          op === ">"  ? n > threshold  :
          op === "<=" ? n <= threshold :
          op === "<"  ? n < threshold  :
          false;
        return isExceeded ? "I see, I've noted that. " : "Good. ";
      }
      return n > 0 ? "I see, noted. " : "Good. ";
    }
  }

  return "Thank you. ";
}

// ─── Lex response builders ────────────────────────────────────────────────────

function elicitSlot(attrs: Record<string, string>, message: string): LexResponse {
  return {
    sessionState: {
      sessionAttributes: attrs,
      dialogAction:      { type: "ElicitSlot", slotToElicit: "answer" },
      intent: {
        name:  "PatientFollowUp",
        state: "InProgress",
        slots: { answer: null },
      },
    },
    messages: [{ contentType: "PlainText", content: message }],
  };
}

function closeConversation(attrs: Record<string, string>, message: string): LexResponse {
  return {
    sessionState: {
      sessionAttributes: attrs,
      dialogAction:      { type: "Close" },
      intent:            { name: "PatientFollowUp", state: "Fulfilled" },
    },
    messages: [{ contentType: "PlainText", content: message }],
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export const handler = async (event: LexEvent): Promise<LexResponse> => {
  const attrs      = { ...(event.sessionState.sessionAttributes ?? {}) };
  const transcript = (event.inputTranscript ?? "").trim();

  console.log(
    `[lex-fulfillment] source=${event.invocationSource}` +
    ` idx=${attrs["nextQuestionIdx"] ?? "—"}` +
    ` transcript="${transcript.substring(0, 80)}"`,
  );

  // ─── Extract context from session ─────────────────────────────────────────

  const patientId = attrs["patientId"] ?? "";
  const callId    = attrs["callId"]    ?? ("LEX-" + Date.now().toString(16));

  if (!patientId) {
    console.error("[lex-fulfillment] No patientId in session attributes");
    return closeConversation(attrs,
      "I'm sorry, I was unable to locate your records. Your care team will follow up with you shortly.");
  }

  // ─── Load protocol + patient info (cache after first turn) ────────────────
  // On first turn: load both in parallel. On subsequent turns: read from session cache.

  let protocol: Protocol;
  let patientInfo: PatientInfo;

  try {
    const cachedProtocol = attrs["protocolJson"];
    const cachedPatient  = attrs["patientInfoJson"];

    if (cachedProtocol && cachedPatient) {
      protocol    = JSON.parse(cachedProtocol) as Protocol;
      patientInfo = JSON.parse(cachedPatient)  as PatientInfo;
    } else if (cachedProtocol) {
      protocol    = JSON.parse(cachedProtocol) as Protocol;
      patientInfo = await loadPatientInfo(patientId);
    } else if (cachedPatient) {
      protocol    = await loadProtocol(patientId);
      patientInfo = JSON.parse(cachedPatient)  as PatientInfo;
    } else {
      // First turn — load both in parallel to minimise latency before Q1
      [protocol, patientInfo] = await Promise.all([
        loadProtocol(patientId),
        loadPatientInfo(patientId),
      ]);
    }
  } catch (err) {
    console.error("[lex-fulfillment] Protocol load failed:", err);
    return closeConversation(attrs,
      "I'm sorry, your care plan is not available right now. Your care team will follow up with you shortly.");
  }

  const questions = protocol.question_priority ?? [];
  const language  = protocol.preferred_language ?? "en";

  // ─── STEP 1: Determine current position ───────────────────────────────────

  const isFirstTurn = !attrs["initialized"];
  let   nextIdx     = isFirstTurn ? 0 : parseInt(attrs["nextQuestionIdx"] ?? "0", 10);
  const answers: Record<string, string> = JSON.parse(attrs["answersJson"] ?? "{}");
  const attempts: Record<string, number> = JSON.parse(attrs["questionAttempts"] ?? "{}");
  // Safety net: tracks every variable that has been ASKED (regardless of answer quality)
  const askedQuestions: string[] = JSON.parse(attrs["askedQuestionsJson"] ?? "[]");
  let   ackPrefix = "";

  // Dedup guard — Lex may invoke the Lambda twice for the same turn on timeout/retry.
  // Use the last-asked variable + transcript as a fingerprint. If the same turn arrives
  // again, skip answer processing so the same answer is never written twice.
  const lastAskedVar    = askedQuestions[askedQuestions.length - 1] ?? "";
  const turnId          = `${lastAskedVar}:${transcript.substring(0, 60)}`;
  const lastTurnId      = attrs["lastProcessedTurnId"] ?? "";
  const isDuplicateTurn = !isFirstTurn && transcript.length > 0 && turnId === lastTurnId;
  if (isDuplicateTurn) {
    console.warn(`[lex-fulfillment] DUPLICATE turn detected for "${lastAskedVar}" — skipping answer re-processing`);
  }

  // ─── STEP 1b: No-input guard ─────────────────────────────────────────────
  // When Lex fires with an empty transcript (no-input / timeout event) and the
  // previously asked variable has no answer yet, roll back so STEP 4 re-asks it.
  // This prevents questions from being silently skipped when the patient is slow
  // to respond after TTS finishes.
  if (!isFirstTurn && transcript === "" && lastAskedVar && answers[lastAskedVar] === undefined) {
    const rollbackIdx = askedQuestions.lastIndexOf(lastAskedVar);
    if (rollbackIdx >= 0) {
      askedQuestions.splice(rollbackIdx, 1);
      nextIdx = Math.max(0, nextIdx - 1);
    }
    console.log(`[lex-fulfillment] no-input for "${lastAskedVar}" — rolling back to re-ask`);
    // Fall through to STEP 4 which will re-ask lastAskedVar
  }

  // ─── STEP 2: Record answer to the previous question ───────────────────────

  // Use askedQuestions[last] as prevVariable — more reliable than questions[nextIdx-1]
  // because nextIdx can drift if questions are skipped or retried.
  const prevVariable = !isFirstTurn ? lastAskedVar : undefined;

  if (!isDuplicateTurn && prevVariable && transcript) {
    {
      const prevCond = protocol.root_node?.conditions?.find(
        (c) => c.variable === prevVariable,
      );
      const ctx: QuestionContext = {
        variable:         prevVariable,
        operator:         prevCond?.operator  ?? ">=",
        threshold:        prevCond?.threshold ?? 0,
        conditionCode:    patientInfo.conditionCode,
        conditionDisplay: patientInfo.conditionDisplay,
        language,
        patientName:      patientInfo.patientName,
        medications:      patientInfo.medications,
      };
      const prevQuestion = formatQuestion(ctx);
      const extraction   = await extractAnswer(transcript, prevVariable, prevQuestion);
      const attemptCount = attempts[prevVariable] ?? 0;

      console.log(
        `[lex-fulfillment] ${prevVariable} → "${extraction.value}" ` +
        `(conf=${extraction.confidence.toFixed(2)}, attempt=${attemptCount})`,
      );

      // ── A2: Redirect on first low-confidence attempt ──────────────────────
      if (extraction.confidence < 0.5 && extraction.value === "unknown" && attemptCount < 1) {
        attempts[prevVariable] = attemptCount + 1;
        const redirectAttrs: Record<string, string> = {
          ...attrs,
          patientId,
          callId,
          initialized:         "true",
          nextQuestionIdx:     String(nextIdx),   // do NOT advance
          answersJson:         JSON.stringify(answers),
          questionsAsked:      attrs["questionsAsked"] ?? "0",
          questionAttempts:    JSON.stringify(attempts),
          askedQuestionsJson:  JSON.stringify(askedQuestions),
          protocolJson:        JSON.stringify(protocol),
          patientInfoJson:     JSON.stringify(patientInfo),
          // Use a redirect-specific sentinel so the patient's repeated answer
          // (same transcript as the original) is never flagged as a duplicate.
          lastProcessedTurnId: `REDIRECT:${prevVariable}`,
        };
        console.log(`[lex-fulfillment] redirecting for ${prevVariable} (attempt 1)`);
        // Do NOT repeat the full question — ask for a simple retry instead
        const clarifyMsg = language === "es"
          ? "Lo siento, no pude escuchar bien. ¿Podría repetir su respuesta, por favor?"
          : "I'm sorry, I didn't quite catch that. Could you please repeat your answer?";
        return elicitSlot(redirectAttrs, clarifyMsg);
      }

      // ── Write answer or mark unresolved ───────────────────────────────────
      answers[prevVariable] = extraction.value;
      if (extraction.value !== "unknown") {
        try {
          await writeAnswer(
            patientId, callId, prevVariable,
            parseExtracted(extraction.value), extraction.confidence,
            { conditionCode: patientInfo.conditionCode, patientName: patientInfo.patientName },
          );
        } catch (err) {
          console.error("[lex-fulfillment] writeAnswer failed:", err);
        }
      } else {
        // Second attempt still unclear — mark as unresolved and move on
        try {
          await markUnresolved(patientId, callId, prevVariable);
        } catch (err) {
          console.error("[lex-fulfillment] markUnresolved failed:", err);
        }
      }

      // ── A4: Acknowledgement prefix for next question ──────────────────────
      ackPrefix = getAckPrefix(prevVariable, extraction.value, extraction.confidence, protocol);
    }
  }

  // ─── STEP 3: All questions answered → close ────────────────────────────────

  const updatedAttrs: Record<string, string> = {
    ...attrs,
    patientId,
    callId,
    initialized:           "true",
    nextQuestionIdx:       String(nextIdx),
    answersJson:           JSON.stringify(answers),
    questionsAsked:        String(nextIdx),
    questionAttempts:      JSON.stringify(attempts),
    askedQuestionsJson:    JSON.stringify(askedQuestions),
    protocolJson:          JSON.stringify(protocol),
    patientInfoJson:       JSON.stringify(patientInfo),
    lastProcessedTurnId:   turnId,
  };

  if (nextIdx >= questions.length) {
    try { await markComplete(patientId, callId); } catch { /* best effort */ }
    try { await fireDownstream(patientId, callId, answers); } catch (err) {
      console.error("[lex-fulfillment] fireDownstream failed:", err);
    }
    console.log(`[lex-fulfillment] All ${questions.length} questions complete`);
    return closeConversation(
      updatedAttrs,
      "Thank you for answering all my questions. Your care team will review this information. Take care.",
    );
  }

  // ─── STEP 4: Format and return next question ───────────────────────────────

  // Use askedQuestions as primary source of truth — find the first variable not yet asked.
  // This is a safety net against index corruption: even if nextIdx is wrong, we never
  // re-ask a question that already appeared in the conversation.
  const nextByAsked = questions.find(v => !askedQuestions.includes(v));

  if (nextByAsked === undefined) {
    // All variables already asked but STEP 3 close check didn't fire — safety-close now.
    console.warn("[lex-fulfillment] SAFETY-NET: all variables in askedQuestions — closing early");
    try { await markComplete(patientId, callId); } catch { /* best effort */ }
    try { await fireDownstream(patientId, callId, answers); } catch { /* best effort */ }
    return closeConversation(updatedAttrs,
      "Thank you for answering all my questions. Your care team will review this information. Take care.");
  }

  const variable = nextByAsked;

  if (questions[nextIdx] !== variable) {
    console.warn(
      `[lex-fulfillment] SAFETY-NET: idx=${nextIdx} -> "${questions[nextIdx] ?? "OOB"}" ` +
      `already asked, advancing to "${variable}"`,
    );
    // Re-sync nextIdx so STEP 2 on the next turn computes prevVariable correctly
    const syncedIdx = questions.indexOf(variable);
    if (syncedIdx >= 0) nextIdx = syncedIdx;
  }

  // Mark this variable as asked BEFORE saving session state
  askedQuestions.push(variable);
  updatedAttrs["askedQuestionsJson"] = JSON.stringify(askedQuestions);

  const condition = protocol.root_node?.conditions?.find((c) => c.variable === variable);

  const ctx: QuestionContext = {
    variable,
    operator:         condition?.operator  ?? ">=",
    threshold:        condition?.threshold ?? 0,
    conditionCode:    patientInfo.conditionCode,
    conditionDisplay: patientInfo.conditionDisplay,
    language,
    patientName:      patientInfo.patientName,
    medications:      patientInfo.medications,
  };

  const questionText = formatQuestion(ctx);
  nextIdx++;

  updatedAttrs["nextQuestionIdx"] = String(nextIdx);
  updatedAttrs["questionsAsked"]  = String(nextIdx);

  // The contact flow's GetCustomerInput.Text plays the greeting exactly once.
  // On turns after the first, prepend an acknowledgement of the previous answer.
  const spokenQuestion = ackPrefix + questionText;

  console.log(
    `[lex-fulfillment] Q${nextIdx}/${questions.length}: "${spokenQuestion.substring(0, 80)}"`,
  );

  return elicitSlot(updatedAttrs, spokenQuestion);
};
