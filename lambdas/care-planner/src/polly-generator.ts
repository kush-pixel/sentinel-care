import * as dotenv from "dotenv";
import * as path from "path";
import {
  PollyClient,
  SynthesizeSpeechCommand,
  type VoiceId,
  type LanguageCode,
} from "@aws-sdk/client-polly";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export interface PollyInput {
  patientId: string;
  questionVariable: string;
  language: string;
}

export interface PollyResult {
  s3Key: string;
  s3Url: string;
  success: boolean;
  error: string | null;
}

// ─── Question scripts ──────────────────────────────────────────────────────────

const QUESTION_SCRIPTS: Record<string, Record<string, string>> = {
  en: {
    weight_gain_lbs:
      "Have you gained more than 3 pounds since leaving the hospital? Please say yes or no.",
    shortness_of_breath:
      "Are you experiencing any shortness of breath or difficulty breathing? Please say yes or no.",
    lasix_filled:
      "Have you filled your Lasix or Furosemide prescription? Please say yes or no.",
    ankle_swelling:
      "Have you noticed any swelling in your ankles or feet? Please say yes or no.",
    pain_level:
      "On a scale of zero to ten how would you rate your pain right now? Please say a number.",
    fever:
      "Have you taken your temperature today? If yes what was it? Please say your temperature or say I have not checked.",
    wound_drainage:
      "Have you noticed any drainage or unusual wetness around your wound or surgical site? Please say yes or no.",
    blood_sugar_level:
      "Have you checked your blood sugar today? If yes what was the reading? Please say your number.",
    medication_adherence:
      "Have you been taking all of your prescribed medications as directed? Please say yes or no.",
    dizziness:
      "Have you experienced any dizziness or feeling faint? Please say yes or no.",
    appetite:
      "Have you been able to eat and drink normally today? Please say yes or no.",
    mobility:
      "Have you been able to move around and walk as expected since leaving the hospital? Please say yes or no.",
    antibiotic_taken:
      "Have you been taking your antibiotic medication as prescribed? Please say yes or no.",
    confusion:
      "Have you noticed any confusion or difficulty thinking clearly? Please say yes or no.",
    chest_pain:
      "Have you experienced any chest pain pressure or tightness? Please say yes or no.",
    swelling:
      "Have you noticed any new swelling in your legs ankles or feet? Please say yes or no.",
  },
  es: {
    weight_gain_lbs:
      "Ha aumentado mas de tres libras desde que salio del hospital? Por favor diga si o no.",
    shortness_of_breath:
      "Tiene dificultad para respirar o falta de aliento? Por favor diga si o no.",
    medication_adherence:
      "Ha tomado todos sus medicamentos recetados segun las indicaciones? Por favor diga si o no.",
    chest_pain:
      "Ha tenido algun dolor o presion en el pecho? Por favor diga si o no.",
    pain_level:
      "En una escala del cero al diez como calificaria su dolor? Por favor diga un numero.",
  },
};

function getQuestionText(variable: string, language: string): string {
  const langScripts = QUESTION_SCRIPTS[language] ?? QUESTION_SCRIPTS["en"];
  return (
    langScripts?.[variable] ??
    QUESTION_SCRIPTS["en"]?.[variable] ??
    `Please describe how you are feeling regarding ${variable}. Please say yes no or a number.`
  );
}

// ─── Main export ───────────────────────────────────────────────────────────────

export async function generateQuestionAudio(input: PollyInput): Promise<PollyResult> {
  const s3Key = `audio/${input.patientId}/${input.questionVariable}.mp3`;

  // Local dev mode — skip all AWS calls
  if (process.env["DYNAMO_ENDPOINT"]) {
    console.log(`Local dev mode — skipping Polly/S3 for ${input.questionVariable}`);
    return {
      s3Key,
      s3Url: `http://localhost-mock/${input.patientId}/${input.questionVariable}.mp3`,
      success: true,
      error: null,
    };
  }

  try {
    const region = process.env["AWS_REGION"] ?? "us-east-1";
    const voiceId = (process.env["POLLY_VOICE_ID"] ?? "Joanna") as VoiceId;
    const engine = (process.env["POLLY_ENGINE"] ?? "neural") as "neural" | "standard";
    const languageCode = (process.env["POLLY_LANGUAGE_CODE"] ?? "en-US") as LanguageCode;
    const bucket = process.env["S3_AUDIO_BUCKET"] ?? "";

    const questionText = getQuestionText(input.questionVariable, input.language);

    const polly = new PollyClient({ region });
    const speechResult = await polly.send(
      new SynthesizeSpeechCommand({
        Text: questionText,
        VoiceId: voiceId,
        Engine: engine,
        OutputFormat: "mp3",
        LanguageCode: languageCode,
      })
    );

    if (!speechResult.AudioStream) {
      return { s3Key, s3Url: "", success: false, error: "Polly returned no audio stream" };
    }

    const audioBytes = await speechResult.AudioStream.transformToByteArray();

    const s3 = new S3Client({ region });
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: audioBytes,
        ContentType: "audio/mpeg",
      })
    );

    const s3Url = `https://${bucket}.s3.${region}.amazonaws.com/${s3Key}`;
    return { s3Key, s3Url, success: true, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { s3Key, s3Url: "", success: false, error: msg };
  }
}
