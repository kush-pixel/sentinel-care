/**
 * question-formatter.ts — Converts clinical variable names and protocol
 * conditions into natural, patient-friendly speech.
 *
 * Fully dynamic — never assumes a specific condition or variable set.
 * Unknown variables are formatted gracefully from their snake_case name.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QuestionContext {
  variable: string;
  operator: string;
  threshold: number | boolean | string;
  conditionCode: string;
  conditionDisplay: string;
  language: string;
  patientName: string;
  medications: string[];
}

// ─── Medication lookup helpers ────────────────────────────────────────────────

function findMedication(
  medications: string[],
  keywords: string[]
): string | null {
  for (const med of medications) {
    const lower = med.toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw)) return med;
    }
  }
  return null;
}

// ─── English question builder ─────────────────────────────────────────────────

function buildEnglishQuestion(ctx: QuestionContext): string {
  const { variable, operator, threshold, medications } = ctx;

  switch (variable) {
    case "weight_gain_lbs": {
      const t = typeof threshold === "number" ? threshold : 3;
      if (operator === ">=" || operator === ">") {
        return `Have you gained ${t} or more pounds since leaving hospital?`;
      }
      return "Have you noticed any change in your weight?";
    }

    case "shortness_of_breath":
      return "Are you experiencing any shortness of breath or difficulty breathing?";

    case "lasix_filled": {
      const med = findMedication(medications, ["lasix", "furosemide"]);
      if (med) {
        return `Have you been able to pick up your ${med} water tablet from the pharmacy?`;
      }
      return "Have you filled all your prescriptions from the hospital?";
    }

    case "fever": {
      if (typeof threshold === "number") {
        return `Have you had a temperature above ${threshold} degrees Fahrenheit?`;
      }
      return "Have you had a fever?";
    }

    case "antibiotic_taken": {
      const med = findMedication(medications, [
        "amoxicillin", "azithromycin", "doxycycline", "ciprofloxacin",
        "levofloxacin", "trimethoprim", "metronidazole", "clarithromycin",
        "cephalexin", "clindamycin",
      ]);
      if (med) {
        return `Have you been taking your ${med} antibiotic as prescribed?`;
      }
      return "Have you been taking your antibiotic medication as prescribed?";
    }

    case "blood_sugar_level": {
      if (typeof threshold === "number") {
        return (
          `What was your most recent blood sugar reading? ` +
          `Your doctor wants to know if it's been above ${threshold}.`
        );
      }
      return "What has your blood sugar been lately?";
    }

    case "chest_pain":
      return "Have you experienced any chest pain, pressure, or tightness?";

    case "medication_adherence":
      return "Have you been able to take all your medications as prescribed since leaving hospital?";

    case "pain_level": {
      if (typeof threshold === "number") {
        return (
          `On a scale of 0 to 10, what is your current pain level? ` +
          `Your doctor is concerned if it's above ${threshold}.`
        );
      }
      return "On a scale of 0 to 10, what is your current pain level?";
    }

    case "confusion":
      return "Have you felt confused, had memory problems, or had difficulty thinking clearly?";

    case "mobility":
      return "Are you able to move around and get out of bed as expected?";

    case "appetite":
      return "Have you been eating normally? Have you had a good appetite?";

    case "dizziness":
      return "Have you felt dizzy, lightheaded, or unsteady on your feet?";

    case "swelling":
      return "Have you noticed any swelling in your legs, ankles, or feet?";

    case "wound_drainage":
      return (
        "Have you noticed any drainage, redness, or unusual discharge " +
        "from your wound or incision?"
      );

    case "rescue_inhaler_use": {
      if (typeof threshold === "number") {
        return (
          `How many times have you needed to use your rescue inhaler today? ` +
          `Your doctor is concerned if you've used it more than ${threshold} times.`
        );
      }
      return "How often have you been using your rescue inhaler?";
    }

    case "steroid_taken":
      return (
        "Have you been taking your steroid medication — " +
        "the short course your doctor prescribed?"
      );

    case "sputum_colour":
      return (
        "Has the colour of any mucus or phlegm you've coughed up changed? " +
        "Has it become yellow or green?"
      );

    case "oxygen_saturation":
      return (
        "Have you been checking your oxygen level with your home monitor? " +
        "What has it been reading?"
      );

    default: {
      const formatted = variable
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      return `Can you tell me about your ${formatted.toLowerCase()} since leaving hospital?`;
    }
  }
}

// ─── Spanish question builder ─────────────────────────────────────────────────

function buildSpanishQuestion(ctx: QuestionContext): string {
  const { variable, operator, threshold, medications } = ctx;

  switch (variable) {
    case "weight_gain_lbs": {
      const t = typeof threshold === "number" ? threshold : 3;
      if (operator === ">=" || operator === ">") {
        return `¿Ha aumentado ${t} o más libras desde que salió del hospital?`;
      }
      return "¿Ha notado algún cambio en su peso?";
    }

    case "shortness_of_breath":
      return "¿Está experimentando falta de aire o dificultad para respirar?";

    case "lasix_filled": {
      const med = findMedication(medications, ["lasix", "furosemida", "furosemide"]);
      if (med) {
        return `¿Ha podido recoger su pastilla de agua ${med} de la farmacia?`;
      }
      return "¿Ha recogido todas sus recetas del hospital?";
    }

    case "fever": {
      if (typeof threshold === "number") {
        return `¿Ha tenido una temperatura por encima de ${threshold} grados Fahrenheit?`;
      }
      return "¿Ha tenido fiebre?";
    }

    case "antibiotic_taken": {
      const med = findMedication(medications, [
        "amoxicilina", "amoxicillin", "azitromicina", "azithromycin",
        "doxiciclina", "ciprofloxacino", "metronidazol",
      ]);
      if (med) {
        return `¿Ha estado tomando su antibiótico ${med} según lo recetado?`;
      }
      return "¿Ha estado tomando su medicamento antibiótico según lo recetado?";
    }

    case "blood_sugar_level": {
      if (typeof threshold === "number") {
        return (
          `¿Cuál fue su lectura de azúcar en sangre más reciente? ` +
          `Su médico quiere saber si ha estado por encima de ${threshold}.`
        );
      }
      return "¿Cómo ha estado su nivel de azúcar en sangre últimamente?";
    }

    case "chest_pain":
      return "¿Ha experimentado dolor, presión o tensión en el pecho?";

    case "medication_adherence":
      return "¿Ha podido tomar todos sus medicamentos según lo recetado desde que salió del hospital?";

    case "pain_level": {
      if (typeof threshold === "number") {
        return (
          `En una escala del 0 al 10, ¿cuál es su nivel de dolor actual? ` +
          `Su médico está preocupado si está por encima de ${threshold}.`
        );
      }
      return "En una escala del 0 al 10, ¿cuál es su nivel de dolor actual?";
    }

    case "confusion":
      return "¿Se ha sentido confundido, ha tenido problemas de memoria o dificultad para pensar con claridad?";

    case "mobility":
      return "¿Puede moverse y levantarse de la cama según lo esperado?";

    case "appetite":
      return "¿Ha estado comiendo normalmente? ¿Ha tenido buen apetito?";

    case "dizziness":
      return "¿Se ha sentido mareado, aturdido o inestable?";

    case "swelling":
      return "¿Ha notado hinchazón en las piernas, tobillos o pies?";

    case "wound_drainage":
      return "¿Ha notado drenaje, enrojecimiento o secreción inusual en su herida o incisión?";

    case "rescue_inhaler_use": {
      if (typeof threshold === "number") {
        return (
          `¿Cuántas veces ha necesitado usar su inhalador de rescate hoy? ` +
          `Su médico está preocupado si lo ha usado más de ${threshold} veces.`
        );
      }
      return "¿Con qué frecuencia ha estado usando su inhalador de rescate?";
    }

    case "steroid_taken":
      return "¿Ha estado tomando su medicamento esteroide — el tratamiento corto que le recetó su médico?";

    case "sputum_colour":
      return "¿Ha cambiado el color del moco o esputo que ha expectorado? ¿Se ha vuelto amarillo o verde?";

    case "oxygen_saturation":
      return "¿Ha estado revisando su nivel de oxígeno con su monitor en casa? ¿Qué lectura ha tenido?";

    default: {
      const formatted = variable.replace(/_/g, " ");
      return `¿Puede contarme sobre ${formatted} desde que salió del hospital?`;
    }
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function formatQuestion(ctx: QuestionContext): string {
  if (ctx.language === "es") {
    return buildSpanishQuestion(ctx);
  }
  return buildEnglishQuestion(ctx);
}

// ─── Follow-up questions ──────────────────────────────────────────────────────

export function getFollowUpQuestion(
  variable: string,
  patientResponse: string,
  language: string
): string {
  if (language === "es") {
    return getSpanishFollowUp(variable, patientResponse);
  }
  return getEnglishFollowUp(variable, patientResponse);
}

function getEnglishFollowUp(variable: string, patientResponse: string): string {
  switch (variable) {
    case "weight_gain_lbs":
      return (
        "Just to confirm — when you weighed yourself, what was the number on the scale " +
        "compared to when you left hospital?"
      );

    case "pain_level": {
      // Parse rough range from response like "7 or 8", "about 6"
      const nums = patientResponse.match(/\d+/g)?.map(Number) ?? [];
      if (nums.length >= 2) {
        const lower = Math.min(...nums);
        const upper = Math.max(...nums);
        return `When you say "${patientResponse}", would you say that's closer to a ${lower} or a ${upper} on the scale?`;
      }
      return `When you say "${patientResponse}", could you give me a specific number from 0 to 10?`;
    }

    case "shortness_of_breath":
      return (
        "Is that shortness of breath happening when you're resting, " +
        "or only when you're moving around?"
      );

    case "fever":
      return (
        "Did you take your temperature with a thermometer, " +
        "or did you just feel warm?"
      );

    default:
      return (
        "I want to make sure I understood you correctly. " +
        "Could you tell me a little more about that?"
      );
  }
}

function getSpanishFollowUp(variable: string, patientResponse: string): string {
  switch (variable) {
    case "weight_gain_lbs":
      return (
        "Solo para confirmar — cuando se pesó, ¿cuál fue el número en la báscula " +
        "comparado con cuando salió del hospital?"
      );

    case "pain_level": {
      const nums = patientResponse.match(/\d+/g)?.map(Number) ?? [];
      if (nums.length >= 2) {
        const lower = Math.min(...nums);
        const upper = Math.max(...nums);
        return `Cuando dice "${patientResponse}", ¿diría que está más cerca de ${lower} o ${upper} en la escala?`;
      }
      return `Cuando dice "${patientResponse}", ¿podría darme un número específico del 0 al 10?`;
    }

    case "shortness_of_breath":
      return (
        "¿Esa falta de aire ocurre cuando está descansando, " +
        "o solo cuando se mueve?"
      );

    case "fever":
      return (
        "¿Se tomó la temperatura con un termómetro, " +
        "o simplemente se sintió con calor?"
      );

    default:
      return (
        "Quiero asegurarme de haberle entendido correctamente. " +
        "¿Podría contarme un poco más al respecto?"
      );
  }
}
