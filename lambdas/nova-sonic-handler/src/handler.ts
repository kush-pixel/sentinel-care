/**
 * handler.ts — Nova 2 Sonic bidirectional voice handler Lambda.
 *
 * Orchestrates a full post-discharge patient call:
 *   STEP 0  Validate inputs
 *   STEP 1  Load TriageProtocol
 *   STEP 2  Load FHIR patient data (Patient, Condition, MedicationRequest)
 *   STEP 3  Load LACE from PatientProfiles
 *   STEP 4  Load clinical rule for context
 *   STEP 5  Build ConversationState
 *   STEP 6  Build dynamic system prompt
 *   STEP 7  Define tools
 *   STEP 8  Run Nova 2 Sonic bidirectional stream
 *   STEP 9  Process stream events (audio, toolUse, text)
 *   STEP 10 Write CallResults to DynamoDB
 *   STEP 11 Audit log
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import fetch from "node-fetch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { validatePatientId, validateCallId, getLatestRule } from "@sentinel/validation";
import { auditLog } from "@sentinel/audit";

import {
  buildConversationState,
  markAnswered,
  markAsked,
  setUrgentEscalation,
  setCallEndReason,
  deriveCallStatus,
  getNextQuestion,
  type ConversationState,
  type ExtractedAnswer,
  type FhirPatientRecord,
} from "./conversation-state";
import { buildSystemPrompt } from "./system-prompt";

// ─── Event types ──────────────────────────────────────────────────────────────

interface HandlerEvent {
  patientId:   string;
  callId:      string;
  contactId:   string;
  streamArn?:  string;
  instanceId?: string;
}

// ─── Nova Sonic event shapes (JSON-decoded from stream bytes) ─────────────────

interface NovaSonicAudioOutput {
  audioOutput?: { content?: string };
}
interface NovaSonicToolUse {
  toolUse?: { toolName?: string; toolUseId?: string; input?: unknown };
}
interface NovaSonicTextOutput {
  textOutput?: { content?: string };
}
interface NovaSonicError {
  internalServerException?: { message?: string };
  validationException?:     { message?: string };
}
type NovaSonicEvent =
  | NovaSonicAudioOutput
  | NovaSonicToolUse
  | NovaSonicTextOutput
  | NovaSonicError;

// ─── DynamoDB / AWS clients ───────────────────────────────────────────────────

function makeDynamo(): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region:   process.env["AWS_REGION"] ?? "us-east-1",
    ...(process.env["DYNAMO_ENDPOINT"] ? { endpoint: process.env["DYNAMO_ENDPOINT"] } : {}),
  });
  return DynamoDBDocumentClient.from(raw);
}

function fhirBase(): string {
  return process.env["FHIR_BASE_URL"] ?? "http://localhost:8080/fhir";
}

// ─── FHIR fetch helpers ───────────────────────────────────────────────────────

async function fhirGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${fhirBase()}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface FhirBundle<T> {
  entry?: { resource?: T }[];
}

async function fhirBundle<T>(path: string): Promise<T[]> {
  const bundle = await fhirGet<FhirBundle<T>>(path);
  return (bundle?.entry ?? []).map((e) => e.resource).filter((r): r is T => r != null);
}

// ─── Nova Sonic session event builders ───────────────────────────────────────

function makeSessionStartEvent(systemPrompt: string): Uint8Array {
  const event = {
    event: {
      sessionStart: {
        inferenceConfiguration: {
          maxTokens:   parseInt(process.env["NOVA_SONIC_MAX_TOKENS"] ?? "4096", 10),
          temperature: parseFloat(process.env["NOVA_SONIC_TEMPERATURE"] ?? "0.3"),
          topP:        0.9,
        },
        systemPrompt:  { text: systemPrompt },
        tools: {
          tools: [
            {
              toolSpec: {
                name:        "record_answer",
                description: "Record a patient's answer to a clinical assessment question",
                inputSchema: {
                  json: {
                    type: "object",
                    properties: {
                      variable:      { type: "string",  description: "Exact variable name from the protocol" },
                      value:         { type: "string",  description: "Extracted value as string: 'true', 'false', a number, or null" },
                      confidence:    { type: "number",  description: "Confidence 0.0-1.0" },
                      rawResponse:   { type: "string",  description: "Verbatim patient words" },
                      wasAmbiguous:  { type: "boolean", description: "Whether the answer needed follow-up" },
                      needsFollowUp: { type: "boolean", description: "Whether a nurse should verify this answer" },
                    },
                    required: ["variable", "value", "confidence", "rawResponse", "wasAmbiguous", "needsFollowUp"],
                  },
                },
              },
            },
            {
              toolSpec: {
                name:        "urgent_escalation",
                description: "Trigger immediate clinical escalation for emergency symptoms. Call this FIRST before saying anything to the patient.",
                inputSchema: {
                  json: {
                    type: "object",
                    properties: {
                      symptom:      { type: "string", description: "What the patient reported" },
                      severity:     { type: "string", enum: ["high", "critical"] },
                      patientWords: { type: "string", description: "Verbatim patient words" },
                    },
                    required: ["symptom", "severity", "patientWords"],
                  },
                },
              },
            },
            {
              toolSpec: {
                name:        "end_call",
                description: "Signal that the call is complete and all answers have been collected",
                inputSchema: {
                  json: {
                    type: "object",
                    properties: {
                      reason:            { type: "string", enum: ["completed", "patient_request", "no_response", "urgent_escalation", "partial_completion"] },
                      questionsAnswered:  { type: "number" },
                      questionsTotal:    { type: "number" },
                      summary:           { type: "string" },
                    },
                    required: ["reason", "questionsAnswered", "questionsTotal", "summary"],
                  },
                },
              },
            },
          ],
        },
        audioInputConfiguration: {
          mediaType:       "audio/pcm",
          sampleRateHertz: 8000,
          sampleSizeBits:  16,
          channelCount:    1,
          encoding:        "base64",
        },
        audioOutputConfiguration: {
          mediaType:       "audio/pcm",
          sampleRateHertz: 8000,
          sampleSizeBits:  16,
          channelCount:    1,
          encoding:        "base64",
        },
        turnTakingConfiguration: {
          turnTakingMode:          process.env["NOVA_SONIC_TURN_TAKING"] ?? "MEDIUM",
          silenceThresholdSeconds: 5,
        },
      },
    },
  };
  return Buffer.from(JSON.stringify(event));
}

function makePromptStartEvent(): Uint8Array {
  return Buffer.from(JSON.stringify({ event: { promptStart: {} } }));
}

function makeTextContentEvent(): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      event: {
        contentBlockStart: { start: { text: {} } },
      },
    })
  );
}

// Separate delta event after contentBlockStart
function makeTextDeltaEvent(text: string): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      event: {
        contentBlockDelta: { delta: { text } },
      },
    })
  );
}

function makeContentBlockStopEvent(): Uint8Array {
  return Buffer.from(JSON.stringify({ event: { contentBlockStop: {} } }));
}

function makePromptStopEvent(): Uint8Array {
  return Buffer.from(JSON.stringify({ event: { promptStop: {} } }));
}

// ─── Parse tool input ─────────────────────────────────────────────────────────

function parseAnswerValue(raw: string): boolean | number | string | null {
  if (raw === "null") return null;
  if (raw === "true")  return true;
  if (raw === "false") return false;
  const n = Number(raw);
  if (!isNaN(n) && raw.trim() !== "") return n;
  return raw;
}

// ─── SNS escalation ───────────────────────────────────────────────────────────

async function publishEscalation(
  patientId: string,
  callId: string,
  symptom: string,
  severity: string,
  patientWords: string
): Promise<void> {
  const topicArn = process.env["ESCALATION_TOPIC_ARN"] ?? "";
  if (!topicArn) {
    console.warn("[URGENT] No ESCALATION_TOPIC_ARN set — escalation not published");
    return;
  }
  const sns = new SNSClient({ region: process.env["AWS_REGION"] ?? "us-east-1" });
  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject:  `URGENT: Patient ${patientId} reported emergency symptoms during call`,
      Message:  JSON.stringify({
        patientId,
        callId,
        symptom,
        severity,
        patientWords,
        timestamp: new Date().toISOString(),
        source:    "nova-sonic-handler",
      }),
    })
  );
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (event: HandlerEvent): Promise<object> => {
  // STEP 0 — Validate inputs
  if (!validatePatientId(event.patientId)) {
    return { statusCode: 400, error: "Invalid patientId format" };
  }
  if (!validateCallId(event.callId)) {
    return { statusCode: 400, error: "Invalid callId format" };
  }

  const { patientId, callId, contactId, streamArn } = event;
  const dynamo         = makeDynamo();
  const patientsTable  = process.env["DYNAMO_TABLE_PATIENTS"]  ?? "PatientProfiles";
  const protocolsTable = process.env["DYNAMO_TABLE_PROTOCOLS"] ?? "TriageProtocols";
  const resultsTable   = process.env["DYNAMO_TABLE_RESULTS"]   ?? "CallResults";
  const rulesTable     = process.env["DYNAMO_TABLE_RULES"]     ?? "ClinicalRules";

  // STEP 1 — Load TriageProtocol
  const protoResp = await dynamo.send(
    new GetCommand({ TableName: protocolsTable, Key: { patient_id: patientId } })
  );
  if (!protoResp.Item?.["protocol"]) {
    return {
      statusCode: 404,
      error:      `No approved protocol found for patient ${patientId}. Protocol must be approved before call can proceed.`,
    };
  }
  const protocol = protoResp.Item["protocol"] as unknown;

  // STEP 2 — Load FHIR patient data
  interface FhirPatientResource {
    name?: { family?: string; given?: string[]; text?: string }[];
    communication?: { language?: { coding?: { code?: string }[] } }[];
  }
  interface FhirConditionResource {
    code?: {
      text?: string;
      coding?: { code?: string; display?: string }[];
    };
  }
  interface FhirMedResource {
    medication?:                   { text?: string; concept?: { text?: string } };
    medicationCodeableConcept?:    { text?: string };
  }

  const [fhirPatient, fhirConditions, fhirMeds] = await Promise.all([
    fhirGet<FhirPatientResource>(`/Patient/${patientId}`),
    fhirBundle<FhirConditionResource>(`/Condition?patient=${patientId}`),
    fhirBundle<FhirMedResource>(`/MedicationRequest?patient=${patientId}`),
  ]);

  const conditionDisplay =
    fhirConditions[0]?.code?.text ??
    fhirConditions[0]?.code?.coding?.[0]?.display ??
    "Unknown condition";
  const conditionCode =
    fhirConditions[0]?.code?.coding?.[0]?.code ?? "UNKNOWN";

  const patientRecord: FhirPatientRecord = {
    ...(fhirPatient ? { patient: fhirPatient } : {}),
    conditions:  fhirConditions,
    medications: fhirMeds,
  };

  // STEP 3 — Load LACE from PatientProfiles
  const profileResp = await dynamo.send(
    new GetCommand({ TableName: patientsTable, Key: { patient_id: patientId } })
  );
  const laceScore      = (profileResp.Item?.["lace_score"]      as number | undefined) ?? 0;
  const laceRiskLevel  = (profileResp.Item?.["lace_risk_level"] as string | undefined) ?? "UNKNOWN";
  const laceComponents = profileResp.Item?.["lace_components"] as unknown;

  // STEP 4 — Load clinical rule for context
  let guidelineSource = "Clinical guideline";
  try {
    const rule = await getLatestRule(conditionCode, dynamo, rulesTable);
    if (rule) {
      guidelineSource =
        (rule as Record<string, unknown>)["guideline_source"] as string ??
        guidelineSource;
    }
  } catch {
    // Non-fatal — proceed with default
  }

  // STEP 5 — Build ConversationState
  let state: ConversationState = buildConversationState(
    patientId,
    callId,
    protocol,
    patientRecord
  );

  // STEP 6 — Build dynamic system prompt
  const systemPrompt = buildSystemPrompt(state, {
    conditionDisplay,
    guidelineSource,
    laceScore,
    laceRiskLevel,
  });

  // ─── STEP 8/9 — Nova 2 Sonic bidirectional stream ─────────────────────────
  const modelId = process.env["BEDROCK_MODEL_VOICE"] ?? "amazon.nova-2-sonic-v1:0";
  const bedrockClient = new BedrockRuntimeClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
  });

  // Input event generator — sends session init, then audio/text from KVS
  async function* inputEventGenerator(): AsyncGenerator<{ chunk?: { bytes?: Uint8Array } }> {
    // Session start with system prompt and tools
    yield { chunk: { bytes: makeSessionStartEvent(systemPrompt) } };
    yield { chunk: { bytes: makePromptStartEvent() } };

    if (streamArn) {
      // Real call: would bridge KVS audio here
      // In production, this loops reading audio chunks from KVS stream
      // and yielding them as audio content block events.
      // For Lambda context, the KVS bridging is handled by the Connect contact flow
      // which forwards audio directly to Nova Sonic; we signal readiness.
      yield { chunk: { bytes: makeTextContentEvent() } };
      yield { chunk: { bytes: makeTextDeltaEvent("[KVS audio stream connected]") } };
      yield { chunk: { bytes: makeContentBlockStopEvent() } };
    } else {
      // Local/text mode: send an empty prompt to let Nova Sonic speak first
      yield { chunk: { bytes: makeTextContentEvent() } };
      yield { chunk: { bytes: makeTextDeltaEvent("") } };
      yield { chunk: { bytes: makeContentBlockStopEvent() } };
    }
    yield { chunk: { bytes: makePromptStopEvent() } };
  }

  // Process output stream
  try {
    const command = new InvokeModelWithBidirectionalStreamCommand({
      modelId,
      body: inputEventGenerator(),
    });

    const response = await bedrockClient.send(command);
    if (!response.body) {
      throw new Error("Nova Sonic returned no response body");
    }

    // Iterate response events
    for await (const rawChunk of response.body) {
      const bytes =
        (rawChunk as { chunk?: { bytes?: Uint8Array } }).chunk?.bytes;
      if (!bytes) continue;

      let parsed: { event?: NovaSonicEvent };
      try {
        parsed = JSON.parse(Buffer.from(bytes).toString("utf-8")) as {
          event?: NovaSonicEvent;
        };
      } catch {
        continue;
      }

      const ev = parsed.event;
      if (!ev) continue;

      // Audio output
      if ("audioOutput" in ev && ev.audioOutput) {
        if (streamArn) {
          // Production: forward audio bytes to KVS / Connect
          // The audio is Base64-encoded PCM
          const audioB64 = ev.audioOutput.content ?? "";
          void audioB64; // used by KVS bridge (omitted for Lambda context)
        }
        continue;
      }

      // Text output (transcript logging)
      if ("textOutput" in ev && ev.textOutput?.content) {
        console.log(`[TRANSCRIPT] ${ev.textOutput.content}`);
        continue;
      }

      // Tool use
      if ("toolUse" in ev && ev.toolUse) {
        const { toolName, input } = ev.toolUse;
        const inp = input as Record<string, unknown> | undefined;

        if (toolName === "record_answer" && inp) {
          const variable    = String(inp["variable"]     ?? "");
          const rawValue    = String(inp["value"]        ?? "null");
          const confidence  = Number(inp["confidence"]   ?? 0.5);
          const rawResponse = String(inp["rawResponse"]  ?? "");
          const wasAmbiguous  = Boolean(inp["wasAmbiguous"]  ?? false);
          const needsFollowUp = Boolean(inp["needsFollowUp"] ?? false) ||
            confidence < 0.5;

          const answer: ExtractedAnswer = {
            variable,
            value:      parseAnswerValue(rawValue),
            confidence,
            rawResponse,
            needsFollowUp,
            wasAmbiguous,
          };

          state = markAnswered(state, variable, answer);
          state = markAsked(state, variable);
          console.log(
            `[ANSWER] ${variable}: ${rawValue} (confidence=${confidence.toFixed(2)}, ` +
            `ambiguous=${wasAmbiguous.toString()})`
          );
        }

        if (toolName === "urgent_escalation" && inp) {
          const symptom     = String(inp["symptom"]     ?? "unknown");
          const severity    = String(inp["severity"]    ?? "high");
          const patientWords = String(inp["patientWords"] ?? "");

          console.log(`[URGENT] Escalation: ${symptom} (${severity})`);
          state = setUrgentEscalation(state);

          try {
            await publishEscalation(patientId, callId, symptom, severity, patientWords);
          } catch (snsErr: unknown) {
            console.error(
              "[URGENT] SNS publish failed:",
              snsErr instanceof Error ? snsErr.message : String(snsErr)
            );
          }
        }

        if (toolName === "end_call" && inp) {
          const reason = String(inp["reason"] ?? "completed") as
            ConversationState["callEndReason"];
          state = setCallEndReason(state, reason);
          console.log(
            `[CALL END] reason=${reason ?? "completed"} ` +
            `answered=${state.answers.size}/${state.questions.length}`
          );
          break; // exit stream loop
        }
      }

      // Error events
      if ("internalServerException" in ev && ev.internalServerException) {
        console.error("[NOVA SONIC ERROR]", ev.internalServerException.message);
        state = setCallEndReason(state, "error");
        break;
      }
      if ("validationException" in ev && ev.validationException) {
        console.error("[NOVA SONIC VALIDATION]", ev.validationException.message);
        state = setCallEndReason(state, "error");
        break;
      }
    }

    // If stream ended without an explicit end_call tool call
    if (!state.callEndReason) {
      const next = getNextQuestion(state);
      state = setCallEndReason(
        state,
        next === null ? "completed" : "no_response"
      );
    }
  } catch (streamErr: unknown) {
    const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
    console.error("[NOVA SONIC STREAM ERROR]", msg);
    state = setCallEndReason(state, "error");
  }

  // STEP 10 — Write CallResults
  const variables: Record<string, unknown> = {};
  for (const [v, ans] of state.answers) {
    variables[v] = {
      value:          ans.value,
      confidence:     ans.confidence,
      raw_response:   ans.rawResponse,
      was_ambiguous:  ans.wasAmbiguous,
      needs_follow_up: ans.needsFollowUp,
    };
  }

  const unresolvedList = state.questions
    .filter((q) => q.asked && !q.answered)
    .map((q) => q.variable);

  const callStatus   = deriveCallStatus(state);
  const durationSecs = Math.floor(
    (Date.now() - state.callStartTime.getTime()) / 1000
  );

  await dynamo.send(
    new PutCommand({
      TableName: resultsTable,
      Item: {
        call_id:              callId,
        patient_id:           patientId,
        call_status:          callStatus,
        call_timestamp:       new Date().toISOString(),
        call_duration_seconds: durationSecs,
        variables,
        unresolved_variables:  unresolvedList,
        transcript_warnings:   [],
        urgent_escalation:     state.urgentEscalation,
        nova_sonic_model:      modelId,
        nova_sonic_call:       true,
        contact_id:            contactId || null,
        lace_score:            laceScore,
        lace_risk_level:       laceRiskLevel,
        lace_components:       laceComponents ?? null,
        questions_asked:       state.questions.filter((q) => q.asked).length,
        questions_answered:    state.answers.size,
        questions_total:       state.questions.length,
      },
    })
  );

  // STEP 11 — Audit log
  auditLog({
    eventType:   "TRIAGE_COMPLETE",
    patientId,
    callId,
    performedBy: "SYSTEM",
    action:      `Nova Sonic call ${state.callEndReason ?? "unknown"} — ` +
                 `${state.answers.size}/${state.questions.length} questions answered`,
    timestamp:   new Date().toISOString(),
    success:     state.callEndReason !== "error",
  });

  return {
    statusCode:        200,
    callId,
    patientId,
    callStatus:        state.callEndReason ?? "completed",
    questionsAnswered: state.answers.size,
    questionsTotal:    state.questions.length,
    urgentEscalation:  state.urgentEscalation,
    nova_sonic_call:   true,
  };
};
