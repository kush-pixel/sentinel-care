import * as dotenv from "dotenv";
import * as path from "path";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export interface BedrockResult {
  rawResponse: string;
  parsedJson: unknown;
  parseSuccess: boolean;
  parseError: string | null;
}

export async function callNovaPro(prompt: string): Promise<BedrockResult> {
  try {
    const modelId = process.env["BEDROCK_MODEL_CARE_PLANNER"] ?? "amazon.nova-lite-v1:0";
    const region = process.env["AWS_REGION"] ?? "us-east-1";

    const client = new BedrockRuntimeClient({ region });

    const requestBody = {
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: {
        maxTokens: 2000,
        temperature: 0.1,
      },
    };

    const command = new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: new TextEncoder().encode(JSON.stringify(requestBody)),
    });

    const response = await client.send(command);

    const bodyText = new TextDecoder().decode(response.body);
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;

    // Try both Nova response shapes
    type ContentBlock = { text?: string };
    type MessageShape = { content?: ContentBlock[] };
    type OutputShape = { message?: MessageShape };

    const output = parsed["output"] as OutputShape | undefined;
    const directContent = parsed["content"] as ContentBlock[] | undefined;

    let rawText =
      (output?.message?.content?.[0]?.text) ??
      (directContent?.[0]?.text) ??
      "";

    // Clean markdown fences if model adds them
    rawText = rawText.trim();
    if (rawText.startsWith("```json")) rawText = rawText.slice(7);
    if (rawText.startsWith("```")) rawText = rawText.slice(3);
    if (rawText.endsWith("```")) rawText = rawText.slice(0, -3);
    rawText = rawText.trim();

    try {
      const parsedJson = JSON.parse(rawText) as unknown;
      return { rawResponse: rawText, parsedJson, parseSuccess: true, parseError: null };
    } catch (jsonErr: unknown) {
      const msg = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
      return { rawResponse: rawText, parsedJson: null, parseSuccess: false, parseError: msg };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      rawResponse: "",
      parsedJson: null,
      parseSuccess: false,
      parseError: msg,
    };
  }
}
