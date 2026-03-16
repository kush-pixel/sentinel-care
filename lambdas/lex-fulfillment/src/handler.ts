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
  threshold:  number;
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

// ─── AWS clients ──────────────────────────────────────────────────────────────

const REGION             = process.env["AWS_REGION"]              ?? "us-east-1";
const PROTOCOLS_TABLE    = process.env["DYNAMO_TABLE_PROTOCOLS"]  ?? "TriageProtocols";
const RESULTS_TABLE      = process.env["DYNAMO_TABLE_RESULTS"]    ?? "CallResults";
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

async function ensureResultRecord(patientId: string, callId: string): Promise<void> {
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
      },
    }));
  } catch (err: unknown) {
    // ConditionalCheckFailedException → record already exists, that's fine
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
  }
}

async function writeAnswer(
  patientId: string,
  callId:    string,
  variable:  string,
  value:     number | boolean | string,
): Promise<void> {
  await ensureResultRecord(patientId, callId);
  await dynamo.send(new UpdateCommand({
    TableName:                RESULTS_TABLE,
    Key:                      { call_id: callId, patient_id: patientId },
    UpdateExpression:         "SET variables.#var = :val, updated_at = :u",
    ExpressionAttributeNames: { "#var": variable },
    ExpressionAttributeValues: {
      ":val": { value, confidence: 0.85 },
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

async function fireDownstream(patientId: string, callId: string, answers: Record<string, string>): Promise<void> {
  const { LambdaClient: LC, InvokeCommand: IC } = await import("@aws-sdk/client-lambda");
  const lc = new LC({ region: REGION });
  const payload = Buffer.from(JSON.stringify({ patientId, callId }));

  console.log("[CALL COMPLETE] patientId:", patientId);
  console.log("[CALL COMPLETE] callId:", callId);
  console.log("[CALL COMPLETE] answers:", JSON.stringify(answers));
  console.log("[CALL COMPLETE] triggering triage...");

  if (TRIAGE_ENGINE_ARN) {
    await lc.send(new IC({ FunctionName: TRIAGE_ENGINE_ARN, InvocationType: "Event", Payload: payload }));
    console.log("[CALL COMPLETE] triage-engine fired →", TRIAGE_ENGINE_ARN);
  } else {
    console.warn("[CALL COMPLETE] LAMBDA_ARN_TRIAGE_ENGINE not set — triage skipped");
  }

  if (SUMMARIZER_ARN) {
    await lc.send(new IC({ FunctionName: SUMMARIZER_ARN, InvocationType: "Event", Payload: payload }));
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

  if (!FHIR_BASE_URL) return fallback;

  try {
    const patRes = await fetch(`${FHIR_BASE_URL}/Patient/${patientId}`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!patRes.ok) return fallback;

    const patient = await patRes.json() as {
      name?: Array<{ given?: string[] }>;
    };
    const patientName = patient.name?.[0]?.given?.[0] ?? "";

    const medRes = await fetch(
      `${FHIR_BASE_URL}/MedicationRequest?patient=${patientId}&status=active`,
      { signal: AbortSignal.timeout(4_000) },
    );
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

    return { patientName, conditionCode: "", conditionDisplay: "", medications };
  } catch {
    return fallback;
  }
}

// ─── Bedrock answer extraction ────────────────────────────────────────────────

const BOOLEAN_VARS = new Set([
  "shortness_of_breath", "lasix_filled", "fever", "antibiotic_taken",
  "chest_pain", "medication_adherence", "confusion", "mobility",
  "appetite", "dizziness", "swelling", "wound_drainage",
  "steroid_taken", "sputum_colour",
]);

const NUMERIC_VARS = new Set([
  "weight_gain_lbs", "blood_sugar_level", "pain_level",
  "oxygen_saturation", "rescue_inhaler_use",
]);

async function extractAnswer(
  transcript:   string,
  variable:     string,
  questionText: string,
): Promise<string> {
  const formatHint = BOOLEAN_VARS.has(variable)
    ? 'Respond with ONLY "true" or "false".'
    : NUMERIC_VARS.has(variable)
    ? 'Respond with ONLY the number (digits only, e.g. "5" or "2.5").'
    : 'Respond with ONLY "true", "false", or a number.';

  const prompt =
    `The patient was asked: "${questionText}"\n` +
    `The patient said: "${transcript}"\n` +
    `Clinical variable: "${variable}"\n\n` +
    `Extract the patient's answer. ${formatHint}\n` +
    `If the patient is unsure, refuses, or the answer is unclear, respond with "unknown".\n` +
    `Respond with ONLY the value — no explanation, no punctuation.`;

  try {
    const body = {
      messages:       [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 16, temperature: 0.0 },
    };

    const resp = await bedrock.send(new InvokeModelCommand({
      modelId:     NOVA_LITE_MODEL,
      contentType: "application/json",
      accept:      "application/json",
      body:        new TextEncoder().encode(JSON.stringify(body)),
    }));

    const result = JSON.parse(new TextDecoder().decode(resp.body)) as {
      output?: { message?: { content?: Array<{ text?: string }> } };
    };

    return result.output?.message?.content?.[0]?.text?.trim().toLowerCase() ?? "unknown";
  } catch (err) {
    console.error("[lex-fulfillment] Bedrock extraction failed:", err);
    return "unknown";
  }
}

function parseExtracted(raw: string): number | boolean | string {
  if (raw === "true")  return true;
  if (raw === "false") return false;
  const n = Number(raw);
  if (!isNaN(n) && raw !== "") return n;
  return raw;
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

  let protocol: Protocol;
  try {
    protocol = attrs["protocolJson"]
      ? JSON.parse(attrs["protocolJson"]) as Protocol
      : await loadProtocol(patientId);
  } catch (err) {
    console.error("[lex-fulfillment] Protocol load failed:", err);
    return closeConversation(attrs,
      "I'm sorry, your care plan is not available right now. Your care team will follow up with you shortly.");
  }

  let patientInfo: PatientInfo;
  patientInfo = attrs["patientInfoJson"]
    ? JSON.parse(attrs["patientInfoJson"]) as PatientInfo
    : await loadPatientInfo(patientId);

  const questions = protocol.question_priority ?? [];
  const language  = protocol.preferred_language ?? "en";

  // ─── STEP 1: Determine current position ───────────────────────────────────

  const isFirstTurn  = !attrs["initialized"];
  let   nextIdx      = isFirstTurn ? 0 : parseInt(attrs["nextQuestionIdx"] ?? "0", 10);
  const answers: Record<string, string> = JSON.parse(attrs["answersJson"] ?? "{}");

  // ─── STEP 2: Record answer to the previous question ───────────────────────

  if (!isFirstTurn && nextIdx > 0 && transcript) {
    const prevVariable = questions[nextIdx - 1];
    if (prevVariable) {
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
      const rawAnswer    = await extractAnswer(transcript, prevVariable, prevQuestion);
      answers[prevVariable] = rawAnswer;

      if (rawAnswer !== "unknown") {
        try {
          await writeAnswer(patientId, callId, prevVariable, parseExtracted(rawAnswer));
        } catch (err) {
          console.error("[lex-fulfillment] writeAnswer failed:", err);
        }
      }

      console.log(`[lex-fulfillment] ${prevVariable} → "${rawAnswer}"`);
    }
  }

  // ─── STEP 3: All questions answered → close ────────────────────────────────

  const updatedAttrs: Record<string, string> = {
    ...attrs,
    patientId,
    callId,
    initialized:     "true",
    nextQuestionIdx: String(nextIdx),
    answersJson:     JSON.stringify(answers),
    questionsAsked:  String(nextIdx),
    protocolJson:    JSON.stringify(protocol),
    patientInfoJson: JSON.stringify(patientInfo),
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

  const variable  = questions[nextIdx];
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
  // On every turn (including the first) the Lambda returns only the question.
  const spokenQuestion = questionText;

  console.log(
    `[lex-fulfillment] Q${nextIdx}/${questions.length}: "${spokenQuestion.substring(0, 80)}"`,
  );

  return elicitSlot(updatedAttrs, spokenQuestion);
};
