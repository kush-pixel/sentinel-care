import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { extractValue } from "./extractor";

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (event: {
  Details?: {
    ContactData?: {
      Attributes?: {
        patientId?: string;
        callId?: string;
      };
    };
    Parameters?: {
      transcript?: string;
      questionVariable?: string;
      expectedType?: string;
    };
  };
}): Promise<object> => {
  const attributes = event.Details?.ContactData?.Attributes;
  const parameters = event.Details?.Parameters;

  const patientId       = attributes?.patientId;
  const callId          = attributes?.callId;
  const transcript      = parameters?.transcript;
  const questionVariable = parameters?.questionVariable;
  const expectedType    = parameters?.expectedType;

  if (
    !patientId ||
    !callId ||
    !transcript ||
    !questionVariable ||
    !expectedType
  ) {
    return { success: false, error: "Missing required fields" };
  }

  if (
    expectedType !== "boolean" &&
    expectedType !== "number" &&
    expectedType !== "yn"
  ) {
    return { success: false, error: "Invalid expectedType" };
  }

  const result = await extractValue({
    transcript,
    questionVariable,
    expectedType,
  });

  return {
    success: true,
    variable:   result.variable,
    value:      result.extractedValue,
    confidence: result.confidence,
    fallback:   result.fallback,
  };
};
