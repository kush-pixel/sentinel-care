import * as dotenv from "dotenv";
import * as path from "path";
import fetch from "node-fetch";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ─── Custom error classes ─────────────────────────────────────────────────────

export class FhirNotFoundError extends Error {
  readonly statusCode = 404 as const;
  constructor(resource: string, id: string) {
    super(`FHIR ${resource}/${id} not found`);
    Object.setPrototypeOf(this, FhirNotFoundError.prototype);
  }
}

export class FhirError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    Object.setPrototypeOf(this, FhirError.prototype);
  }
}

// ─── FHIR types ───────────────────────────────────────────────────────────────

export interface FhirCoding {
  system?: string;
  code: string;
  display?: string;
}

export interface FhirCodeableConcept {
  coding: FhirCoding[];
  text?: string;
}

export interface FhirExtension {
  url: string;
  valueDate?: string;
  valueString?: string;
}

export interface FhirPatient {
  resourceType: "Patient";
  id: string;
  name: Array<{ family: string; given: string[] }>;
  birthDate: string;
  gender: string;
  communication?: Array<{ language: FhirCodeableConcept }>;
  extension?: FhirExtension[];
}

export interface FhirCondition {
  resourceType: "Condition";
  id: string;
  subject: { reference: string };
  code: FhirCodeableConcept;
  clinicalStatus?: FhirCodeableConcept;
}

export interface FhirMedication {
  resourceType: "MedicationRequest";
  id: string;
  subject: { reference: string };
  status: string;
  intent: string;
  medicationCodeableConcept: FhirCodeableConcept;
}

export interface FhirBundle<T> {
  resourceType: "Bundle";
  entry?: Array<{ resource: T }>;
}

export interface FhirFullRecord {
  patient: FhirPatient;
  conditions: FhirCondition[];
  medications: FhirMedication[];
  encounterSummary: PatientEncounterSummary;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function baseUrl(): string {
  const url = process.env["FHIR_BASE_URL"];
  if (!url) throw new Error("FHIR_BASE_URL is not set");
  return url;
}

// ─── Exported functions ───────────────────────────────────────────────────────

export async function getPatient(patientId: string): Promise<FhirPatient> {
  const res = await fetch(`${baseUrl()}/Patient/${patientId}`);
  if (res.status === 404) throw new FhirNotFoundError("Patient", patientId);
  if (!res.ok)
    throw new FhirError(`FHIR Patient fetch failed: ${res.statusText}`, res.status);
  return (await res.json()) as FhirPatient;
}

export async function getConditions(patientId: string): Promise<FhirCondition[]> {
  const res = await fetch(`${baseUrl()}/Condition?patient=${patientId}`);
  if (!res.ok) return [];
  const bundle = (await res.json()) as FhirBundle<FhirCondition>;
  return (bundle.entry ?? []).map((e) => e.resource);
}

export async function getMedications(patientId: string): Promise<FhirMedication[]> {
  const res = await fetch(`${baseUrl()}/MedicationRequest?patient=${patientId}`);
  if (!res.ok) return [];
  const bundle = (await res.json()) as FhirBundle<FhirMedication>;
  return (bundle.entry ?? []).map((e) => e.resource);
}

export async function getFullPatientRecord(patientId: string): Promise<FhirFullRecord> {
  const today = new Date().toISOString().slice(0, 10);
  const [patient, conditions, medications, encounterSummary] = await Promise.all([
    getPatient(patientId),
    getConditions(patientId),
    getMedications(patientId),
    getPatientEncounterSummary(patientId, today),
  ]);
  return { patient, conditions, medications, encounterSummary };
}

// ─── Encounter types ──────────────────────────────────────────────────────────

export interface FhirEncounter {
  id: string;
  status: string;
  class: { code: string; display?: string };
  type?: Array<{ coding: Array<{ code: string; display?: string }> }>;
  subject: { reference: string };
  period: { start: string; end?: string };
  hospitalization?: {
    admitSource?: {
      coding: Array<{ code: string; display?: string }>;
    };
  };
}

export interface PatientEncounterSummary {
  admissionEncounter: FhirEncounter | null;
  admissionType: "EMERGENCY" | "PLANNED";
  admissionDate: string;
  dischargeDate: string;
  recentEDVisits: number;
  allEncounters: FhirEncounter[];
}

export async function getEncounters(
  patientId: string
): Promise<FhirEncounter[]> {
  try {
    const res = await fetch(`${baseUrl()}/Encounter?patient=${patientId}`);
    if (!res.ok) return [];
    const bundle = (await res.json()) as FhirBundle<FhirEncounter>;
    return (bundle.entry ?? []).map((e) => e.resource);
  } catch {
    return [];
  }
}

export async function getPatientEncounterSummary(
  patientId: string,
  dischargeDate: string
): Promise<PatientEncounterSummary> {
  const allEncounters = await getEncounters(patientId);

  // Find the latest inpatient (IMP) admission encounter
  const inpatientEncounters = allEncounters.filter(
    (e) => e.class.code === "IMP"
  );
  const admissionEncounter =
    inpatientEncounters.sort(
      (a, b) =>
        new Date(b.period.start).getTime() -
        new Date(a.period.start).getTime()
    )[0] ?? null;

  // Determine admission type
  let admissionType: "EMERGENCY" | "PLANNED" = "PLANNED";
  if (admissionEncounter) {
    const admitCode =
      admissionEncounter.hospitalization?.admitSource?.coding?.[0]?.code ?? "";
    const typeCode =
      admissionEncounter.type?.[0]?.coding?.[0]?.code ?? "";
    if (
      admitCode.toLowerCase().includes("emd") ||
      admitCode.toLowerCase().includes("emergency") ||
      typeCode === "EMER"
    ) {
      admissionType = "EMERGENCY";
    }
  }

  const admissionDate = admissionEncounter?.period.start.slice(0, 10) ?? dischargeDate;
  const dischargeDateStr = admissionEncounter?.period.end?.slice(0, 10) ?? dischargeDate;

  // Count ED visits in last 180 days before the actual encounter discharge date
  const dischargeDateMs = new Date(dischargeDateStr).getTime();
  const cutoffMs = dischargeDateMs - 180 * 24 * 60 * 60 * 1000;
  const admissionEncounterId = admissionEncounter?.id ?? "";

  const recentEDVisits = allEncounters.filter((e) => {
    if (e.id === admissionEncounterId) return false;
    if (e.class.code !== "EMER") return false;
    const startMs = new Date(e.period.start).getTime();
    return startMs >= cutoffMs && startMs <= dischargeDateMs;
  }).length;

  return {
    admissionEncounter,
    admissionType,
    admissionDate,
    dischargeDate: dischargeDateStr,
    recentEDVisits,
    allEncounters,
  };
}
