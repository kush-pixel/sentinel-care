/**
 * test-extraction.ts — Validates Nova Lite answer extraction prompt.
 * Run: cd scripts && node_modules/.bin/ts-node src/test-extraction/test-extraction.ts
 */

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const MODEL  = process.env["BEDROCK_MODEL_EXTRACTOR"] ?? "amazon.nova-lite-v1:0";
const bedrock = new BedrockRuntimeClient({ region: REGION });

const BOOLEAN_VARS = new Set([
  "shortness_of_breath", "lasix_filled", "fever", "antibiotic_taken",
  "chest_pain", "medication_adherence", "confusion", "mobility",
  "appetite", "dizziness", "swelling", "ankle_swelling", "wound_drainage",
  "steroid_taken", "sputum_colour",
]);
const NUMERIC_VARS = new Set([
  "weight_gain_lbs", "blood_sugar_level", "pain_level",
  "oxygen_saturation", "rescue_inhaler_use",
]);

const CASES = [
  // Negation cases — were failing before fix
  { variable: "shortness_of_breath", question: "Are you experiencing any shortness of breath or difficulty breathing?",
    transcript: "no i feel fine",        expected: "false" },
  { variable: "shortness_of_breath", question: "Are you experiencing any shortness of breath or difficulty breathing?",
    transcript: "no",                    expected: "false" },
  { variable: "ankle_swelling",       question: "Can you tell me about your ankle swelling since leaving hospital?",
    transcript: "no swelling at all",   expected: "false" },
  { variable: "ankle_swelling",       question: "Have you noticed any swelling in your legs, ankles, or feet?",
    transcript: "no swelling",          expected: "false" },
  // Positive cases
  { variable: "lasix_filled",         question: "Have you been able to pick up your Furosemide (Lasix) 40mg daily water tablet from the pharmacy?",
    transcript: "yes i picked it up",   expected: "true" },
  { variable: "appetite",             question: "Have you been eating normally? Have you had a good appetite?",
    transcript: "yes eating normally",  expected: "true" },
  { variable: "mobility",             question: "Are you able to move around and get out of bed as expected?",
    transcript: "yes moving around fine", expected: "true" },
  // Numeric
  { variable: "weight_gain_lbs",      question: "Have you gained 3 or more pounds since leaving hospital?",
    transcript: "no no weight gain",    expected: "0" },
  { variable: "weight_gain_lbs",      question: "Have you gained 3 or more pounds since leaving hospital?",
    transcript: "yes i gained four pounds", expected: "4" },
  { variable: "pain_level",           question: "On a scale of 0 to 10, what is your current pain level?",
    transcript: "about a seven",        expected: "7" },
];

async function extractAnswer(transcript: string, variable: string, questionText: string): Promise<string> {
  let semanticRules: string;
  let formatHint:    string;

  if (BOOLEAN_VARS.has(variable)) {
    formatHint    = 'Respond with ONLY "true" or "false".';
    semanticRules =
      `- "true"  = the patient CONFIRMS they have / are experiencing this (e.g. "yes", "a little", "kind of", "yes I do", "it hurts")\n` +
      `- "false" = the patient DENIES having / experiencing this (e.g. "no", "no I don't", "I feel fine", "not at all", "none", "no swelling", "no pain", "not really", "I'm fine")`;
  } else if (NUMERIC_VARS.has(variable)) {
    formatHint    = 'Respond with ONLY the number as digits (e.g. "5" or "2.5"). If the patient says "no" or "none" for a count variable, respond with "0".';
    semanticRules = `- Extract the numeric value the patient stated. If they describe a range (e.g. "7 or 8"), use the higher number.`;
  } else {
    formatHint    = 'Respond with ONLY "true", "false", or a number.';
    semanticRules = `- "true" = patient says YES. "false" = patient says NO.`;
  }

  const prompt =
    `You are a medical data extraction system. A patient is on a post-discharge follow-up call.\n\n` +
    `Question asked to patient: "${questionText}"\n` +
    `Patient's spoken response: "${transcript}"\n` +
    `Clinical variable to extract: "${variable}"\n\n` +
    `Extraction rules:\n` +
    `${semanticRules}\n` +
    `- If the patient is unsure, refuses to answer, or the response is completely unclear → "unknown"\n\n` +
    `${formatHint}\n` +
    `Respond with ONLY the value — no explanation, no punctuation.`;

  const body = {
    messages:        [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 16, temperature: 0.0 },
  };
  const resp = await bedrock.send(new InvokeModelCommand({
    modelId:     MODEL,
    contentType: "application/json",
    accept:      "application/json",
    body:        new TextEncoder().encode(JSON.stringify(body)),
  }));
  const result = JSON.parse(new TextDecoder().decode(resp.body)) as {
    output?: { message?: { content?: Array<{ text?: string }> } };
  };
  return result.output?.message?.content?.[0]?.text?.trim().toLowerCase() ?? "unknown";
}

async function main(): Promise<void> {
  const SEP = "─────────────────────────────────────────────";
  console.log(SEP);
  console.log("SENTINEL — EXTRACTION PROMPT TEST");
  console.log(SEP + "\n");

  let passed = 0;
  for (const c of CASES) {
    const result = await extractAnswer(c.transcript, c.variable, c.question);
    const ok = result === c.expected;
    if (ok) passed++;
    const mark = ok ? "✓" : "✗";
    console.log(`${mark} [${c.variable}]`);
    console.log(`  transcript: "${c.transcript}"`);
    console.log(`  expected:   ${c.expected}  got: ${result}${ok ? "" : "  ← FAIL"}\n`);
  }

  console.log(SEP);
  console.log(`RESULT: ${passed}/${CASES.length} passed`);
  console.log(SEP);

  if (passed < CASES.length) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("test failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
