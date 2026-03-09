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
  const [patient, conditions, medications] = await Promise.all([
    getPatient(patientId),
    getConditions(patientId),
    getMedications(patientId),
  ]);
  return { patient, conditions, medications };
}
