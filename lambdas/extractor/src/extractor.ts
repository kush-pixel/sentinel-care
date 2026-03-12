import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExtractionInput {
  transcript: string;
  questionVariable: string;
  expectedType: "boolean" | "number" | "yn";
}

export interface ExtractionResult {
  variable: string;
  extractedValue: number | boolean | null;
  confidence: number;
  rawTranscript: string;
  fallback: boolean;
}

// ─── Bedrock client ───────────────────────────────────────────────────────────

const bedrockClient = new BedrockRuntimeClient({
  region: process.env["AWS_REGION"] ?? "us-east-1",
});

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(input: ExtractionInput): string {
  return `You are extracting a structured value from a patient's spoken response to a medical question.

Question variable: ${input.questionVariable}
Expected type: ${input.expectedType}
Patient said: '${input.transcript}'

Type definitions:
  yn      — patient said yes or no → extract as true (yes) or false (no)
  boolean — same as yn
  number  — patient said a number → extract it as a numeric value

Confidence guidelines:
  0.90-1.00 — patient was completely clear
  0.70-0.89 — patient was mostly clear
  0.50-0.69 — patient was somewhat unclear
  0.00-0.49 — patient was unclear or did not answer

Output ONLY this JSON and nothing else:
{
  "value": true/false/number/null,
  "confidence": 0.0-1.0,
  "reasoning": "one sentence explanation"
}

Rules:
- If patient clearly said yes/affirmed: value true
- If patient clearly said no/denied: value false
- If patient gave a number: extract exact number
- If unclear or no answer: value null
- Never guess — low confidence with null is safer than high confidence with wrong value
- For medical safety: when uncertain lean toward null with low confidence rather than a guess`;
}

// ─── Main extractor ───────────────────────────────────────────────────────────

export async function extractValue(
  input: ExtractionInput
): Promise<ExtractionResult> {
  const fallbackResult: ExtractionResult = {
    variable: input.questionVariable,
    extractedValue: null,
    confidence: 0.0,
    rawTranscript: input.transcript,
    fallback: true,
  };

  try {
    const prompt = buildPrompt(input);

    const requestBody = {
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: {
        maxTokens: 200,
        temperature: 0.0,
      },
    };

    const command = new InvokeModelCommand({
      modelId: process.env["BEDROCK_MODEL_EXTRACTOR"] ?? "amazon.nova-lite-v1:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(requestBody),
    });

    const response = await bedrockClient.send(command);

    if (!response.body) {
      return fallbackResult;
    }

    const responseText = new TextDecoder().decode(response.body);
    const responseJson = JSON.parse(responseText) as {
      output?: { message?: { content?: Array<{ text?: string }> } };
    };

    // Nova Lite response shape: output.message.content[0].text
    const rawText =
      responseJson.output?.message?.content?.[0]?.text ?? "";

    // Strip markdown code fences if present
    const cleaned = rawText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();

    const parsed = JSON.parse(cleaned) as {
      value: number | boolean | null;
      confidence: number;
      reasoning?: string;
    };

    return {
      variable: input.questionVariable,
      extractedValue: parsed.value,
      confidence: parsed.confidence,
      rawTranscript: input.transcript,
      fallback: false,
    };
  } catch {
    return fallbackResult;
  }
}
