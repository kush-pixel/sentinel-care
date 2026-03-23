/**
 * fhir-mock/handler.ts — Serverless read-only FHIR mock.
 *
 * Handles GET requests for Patient, Condition, and Encounter resources
 * for the 6 static demo patients (P001–P006). Deployed with a Lambda
 * Function URL (AuthType: NONE) to replace the EC2 HAPI FHIR server.
 *
 * Supported paths:
 *   GET /fhir/Patient/{id}
 *   GET /fhir/Condition?patient={id}
 *   GET /fhir/Encounter?patient={id}
 *   GET /fhir/MedicationRequest?patient={id}
 *   GET /fhir/metadata
 */

// ─── Static Patient data ──────────────────────────────────────────────────────

type FhirResource = Record<string, unknown>;

interface PatientRecord {
  patient: FhirResource;
  conditions: FhirResource[];
  medications: FhirResource[];
}

const PATIENTS: PatientRecord[] = [
  {
    patient: {
      resourceType: "Patient",
      id: "P001",
      name: [{ family: "Torres", given: ["Margaret"] }],
      birthDate: "1955-01-15",
      gender: "female",
      communication: [{ language: { coding: [{ system: "urn:ietf:bcp:47", code: "en" }] } }],
      extension: [
        { url: "discharge-date", valueDate: "2026-03-06" },
        { url: "readmission-risk", valueString: "HIGH" },
        { url: "attending-physician", valueString: "Dr. Sarah Chen" },
      ],
    },
    conditions: [
      {
        resourceType: "Condition",
        id: "COND-P001-1",
        subject: { reference: "Patient/P001" },
        code: {
          coding: [
            {
              system: "http://hl7.org/fhir/sid/icd-10",
              code: "I50.9",
              display: "Heart failure, unspecified",
            },
          ],
        },
        clinicalStatus: { coding: [{ code: "active" }] },
      },
    ],
    medications: [
      {
        resourceType: "MedicationRequest",
        id: "MED-P001-1",
        subject: { reference: "Patient/P001" },
        status: "active",
        intent: "order",
        medicationCodeableConcept: {
          coding: [
            {
              system: "http://www.nlm.nih.gov/research/umls/rxnorm",
              code: "203150",
              display: "Furosemide (Lasix) 40mg daily",
            },
          ],
        },
      },
    ],
  },
  {
    patient: {
      resourceType: "Patient",
      id: "P002",
      name: [{ family: "Chen", given: ["Robert"] }],
      birthDate: "1962-03-22",
      gender: "male",
      communication: [{ language: { coding: [{ system: "urn:ietf:bcp:47", code: "en" }] } }],
      extension: [
        { url: "discharge-date", valueDate: "2026-03-07" },
        { url: "readmission-risk", valueString: "MODERATE" },
        { url: "attending-physician", valueString: "Dr. James Park" },
      ],
    },
    conditions: [
      {
        resourceType: "Condition",
        id: "COND-P002-1",
        subject: { reference: "Patient/P002" },
        code: {
          coding: [
            {
              system: "http://hl7.org/fhir/sid/icd-10",
              code: "Z96.651",
              display: "Post-op right knee replacement",
            },
          ],
        },
        clinicalStatus: { coding: [{ code: "active" }] },
      },
    ],
    medications: [
      {
        resourceType: "MedicationRequest",
        id: "MED-P002-1",
        subject: { reference: "Patient/P002" },
        status: "active",
        intent: "order",
        medicationCodeableConcept: {
          coding: [
            {
              system: "http://www.nlm.nih.gov/research/umls/rxnorm",
              code: "41493",
              display: "Aspirin 81mg daily",
            },
          ],
        },
      },
    ],
  },
  {
    patient: {
      resourceType: "Patient",
      id: "P003",
      name: [{ family: "Washington", given: ["Linda"] }],
      birthDate: "1968-07-04",
      gender: "female",
      communication: [{ language: { coding: [{ system: "urn:ietf:bcp:47", code: "en" }] } }],
      extension: [
        { url: "discharge-date", valueDate: "2026-03-07" },
        { url: "readmission-risk", valueString: "LOW" },
        { url: "attending-physician", valueString: "Dr. Priya Patel" },
      ],
    },
    conditions: [
      {
        resourceType: "Condition",
        id: "COND-P003-1",
        subject: { reference: "Patient/P003" },
        code: {
          coding: [
            {
              system: "http://hl7.org/fhir/sid/icd-10",
              code: "E11.9",
              display: "Type 2 diabetes, uncomplicated",
            },
          ],
        },
        clinicalStatus: { coding: [{ code: "active" }] },
      },
    ],
    medications: [
      {
        resourceType: "MedicationRequest",
        id: "MED-P003-1",
        subject: { reference: "Patient/P003" },
        status: "active",
        intent: "order",
        medicationCodeableConcept: {
          coding: [
            {
              system: "http://www.nlm.nih.gov/research/umls/rxnorm",
              code: "860975",
              display: "Metformin 500mg twice daily",
            },
          ],
        },
      },
    ],
  },
  {
    patient: {
      resourceType: "Patient",
      id: "P004",
      name: [{ family: "Miller", given: ["James"] }],
      birthDate: "1958-11-30",
      gender: "male",
      communication: [{ language: { coding: [{ system: "urn:ietf:bcp:47", code: "en" }] } }],
      extension: [
        { url: "discharge-date", valueDate: "2026-03-07" },
        { url: "readmission-risk", valueString: "HIGH" },
        { url: "attending-physician", valueString: "Dr. Ahmed Hassan" },
      ],
    },
    conditions: [
      {
        resourceType: "Condition",
        id: "COND-P004-1",
        subject: { reference: "Patient/P004" },
        code: {
          coding: [
            {
              system: "http://hl7.org/fhir/sid/icd-10",
              code: "J18.9",
              display: "Pneumonia, unspecified",
            },
          ],
        },
        clinicalStatus: { coding: [{ code: "active" }] },
      },
    ],
    medications: [
      {
        resourceType: "MedicationRequest",
        id: "MED-P004-1",
        subject: { reference: "Patient/P004" },
        status: "active",
        intent: "order",
        medicationCodeableConcept: {
          coding: [
            {
              system: "http://www.nlm.nih.gov/research/umls/rxnorm",
              code: "723",
              display: "Amoxicillin 500mg three times daily",
            },
          ],
        },
      },
    ],
  },
  {
    patient: {
      resourceType: "Patient",
      id: "P005",
      name: [{ family: "Martinez", given: ["Rosa"] }],
      birthDate: "1960-05-18",
      gender: "female",
      communication: [{ language: { coding: [{ system: "urn:ietf:bcp:47", code: "es" }] } }],
      extension: [
        { url: "discharge-date", valueDate: "2026-03-06" },
        { url: "readmission-risk", valueString: "HIGH" },
        { url: "attending-physician", valueString: "Dr. Michael Torres" },
      ],
    },
    conditions: [
      {
        resourceType: "Condition",
        id: "COND-P005-1",
        subject: { reference: "Patient/P005" },
        code: {
          coding: [
            {
              system: "http://hl7.org/fhir/sid/icd-10",
              code: "I21.9",
              display: "Acute myocardial infarction, unspecified",
            },
          ],
        },
        clinicalStatus: { coding: [{ code: "active" }] },
      },
    ],
    medications: [
      {
        resourceType: "MedicationRequest",
        id: "MED-P005-1",
        subject: { reference: "Patient/P005" },
        status: "active",
        intent: "order",
        medicationCodeableConcept: {
          coding: [
            {
              system: "http://www.nlm.nih.gov/research/umls/rxnorm",
              code: "308460",
              display: "Aspirin 325mg daily",
            },
          ],
        },
      },
      {
        resourceType: "MedicationRequest",
        id: "MED-P005-2",
        subject: { reference: "Patient/P005" },
        status: "active",
        intent: "order",
        medicationCodeableConcept: {
          coding: [
            {
              system: "http://www.nlm.nih.gov/research/umls/rxnorm",
              code: "41493",
              display: "Clopidogrel 75mg daily",
            },
          ],
        },
      },
    ],
  },
  {
    patient: {
      resourceType: "Patient",
      id: "P008",
      name: [{ family: "Chen", given: ["David"] }],
      birthDate: "1958-03-22",
      gender: "male",
    },
    conditions: [
      {
        resourceType: "Condition",
        id: "COND-P008-1",
        subject: { reference: "Patient/P008" },
        code: {
          coding: [
            {
              system: "http://hl7.org/fhir/sid/icd-10",
              code: "I10",
              display: "Hypertensive crisis",
            },
          ],
        },
        clinicalStatus: { coding: [{ code: "active" }] },
      },
    ],
    medications: [
      {
        resourceType: "MedicationRequest",
        id: "MED-P008-1",
        subject: { reference: "Patient/P008" },
        status: "active",
        intent: "order",
        medicationCodeableConcept: {
          coding: [
            {
              system: "http://www.nlm.nih.gov/research/umls/rxnorm",
              code: "29046",
              display: "Lisinopril 10mg daily",
            },
          ],
        },
      },
    ],
  },
  {
    patient: {
      resourceType: "Patient",
      id: "P006",
      name: [{ family: "Thompson", given: ["David"] }],
      birthDate: "1952-09-12",
      gender: "male",
      communication: [{ language: { coding: [{ system: "urn:ietf:bcp:47", code: "en" }] } }],
      extension: [
        { url: "discharge-date", valueDate: "2026-03-07" },
        { url: "readmission-risk", valueString: "MODERATE" },
        { url: "attending-physician", valueString: "Dr. Lisa Wong" },
      ],
    },
    conditions: [
      {
        resourceType: "Condition",
        id: "COND-P006-1",
        subject: { reference: "Patient/P006" },
        code: {
          coding: [
            {
              system: "http://hl7.org/fhir/sid/icd-10",
              code: "N18.3",
              display: "Chronic kidney disease, stage 3",
            },
          ],
        },
        clinicalStatus: { coding: [{ code: "active" }] },
      },
    ],
    medications: [
      {
        resourceType: "MedicationRequest",
        id: "MED-P006-1",
        subject: { reference: "Patient/P006" },
        status: "active",
        intent: "order",
        medicationCodeableConcept: {
          coding: [
            {
              system: "http://www.nlm.nih.gov/research/umls/rxnorm",
              code: "29046",
              display: "Lisinopril 10mg daily",
            },
          ],
        },
      },
    ],
  },
];

// ─── Static Encounter data ────────────────────────────────────────────────────

const ENCOUNTERS: FhirResource[] = [
  // P001
  {
    resourceType: "Encounter", id: "ENC-P001-ADMIT", status: "finished",
    class: { code: "IMP", display: "inpatient encounter" },
    type: [{ coding: [{ code: "EMER", display: "Emergency" }] }],
    subject: { reference: "Patient/P001" },
    period: { start: "2026-02-28T08:00:00Z", end: "2026-03-06T14:00:00Z" },
    hospitalization: { admitSource: { coding: [{ code: "emd", display: "From accident/emergency department" }] } },
  },
  {
    resourceType: "Encounter", id: "ENC-P001-ED-1", status: "finished",
    class: { code: "EMER", display: "emergency" },
    subject: { reference: "Patient/P001" },
    period: { start: "2025-10-15T20:00:00Z", end: "2025-10-15T23:00:00Z" },
  },
  {
    resourceType: "Encounter", id: "ENC-P001-ED-2", status: "finished",
    class: { code: "EMER", display: "emergency" },
    subject: { reference: "Patient/P001" },
    period: { start: "2025-12-03T15:00:00Z", end: "2025-12-03T18:00:00Z" },
  },
  // P002
  {
    resourceType: "Encounter", id: "ENC-P002-ADMIT", status: "finished",
    class: { code: "IMP", display: "inpatient encounter" },
    type: [{ coding: [{ code: "elective", display: "Elective" }] }],
    subject: { reference: "Patient/P002" },
    period: { start: "2026-03-05T07:00:00Z", end: "2026-03-07T11:00:00Z" },
    hospitalization: { admitSource: { coding: [{ code: "routin", display: "Routine" }] } },
  },
  // P003
  {
    resourceType: "Encounter", id: "ENC-P003-ADMIT", status: "finished",
    class: { code: "IMP", display: "inpatient encounter" },
    type: [{ coding: [{ code: "EMER", display: "Emergency" }] }],
    subject: { reference: "Patient/P003" },
    period: { start: "2026-03-05T14:00:00Z", end: "2026-03-07T10:00:00Z" },
    hospitalization: { admitSource: { coding: [{ code: "emd", display: "From accident/emergency department" }] } },
  },
  {
    resourceType: "Encounter", id: "ENC-P003-ED-1", status: "finished",
    class: { code: "EMER", display: "emergency" },
    subject: { reference: "Patient/P003" },
    period: { start: "2025-11-20T18:00:00Z", end: "2025-11-20T21:00:00Z" },
  },
  // P004
  {
    resourceType: "Encounter", id: "ENC-P004-ADMIT", status: "finished",
    class: { code: "IMP", display: "inpatient encounter" },
    type: [{ coding: [{ code: "EMER", display: "Emergency" }] }],
    subject: { reference: "Patient/P004" },
    period: { start: "2026-03-04T22:00:00Z", end: "2026-03-07T09:00:00Z" },
    hospitalization: { admitSource: { coding: [{ code: "emd", display: "From accident/emergency department" }] } },
  },
  {
    resourceType: "Encounter", id: "ENC-P004-ED-1", status: "finished",
    class: { code: "EMER", display: "emergency" },
    subject: { reference: "Patient/P004" },
    period: { start: "2025-09-10T21:00:00Z", end: "2025-09-10T23:00:00Z" },
  },
  {
    resourceType: "Encounter", id: "ENC-P004-ED-2", status: "finished",
    class: { code: "EMER", display: "emergency" },
    subject: { reference: "Patient/P004" },
    period: { start: "2025-11-05T19:00:00Z", end: "2025-11-05T21:00:00Z" },
  },
  {
    resourceType: "Encounter", id: "ENC-P004-ED-3", status: "finished",
    class: { code: "EMER", display: "emergency" },
    subject: { reference: "Patient/P004" },
    period: { start: "2026-01-18T23:00:00Z", end: "2026-01-19T01:00:00Z" },
  },
  // P005
  {
    resourceType: "Encounter", id: "ENC-P005-ADMIT", status: "finished",
    class: { code: "IMP", display: "inpatient encounter" },
    type: [{ coding: [{ code: "EMER", display: "Emergency" }] }],
    subject: { reference: "Patient/P005" },
    period: { start: "2026-03-02T03:00:00Z", end: "2026-03-06T16:00:00Z" },
    hospitalization: { admitSource: { coding: [{ code: "emd", display: "From accident/emergency department" }] } },
  },
  {
    resourceType: "Encounter", id: "ENC-P005-ED-1", status: "finished",
    class: { code: "EMER", display: "emergency" },
    subject: { reference: "Patient/P005" },
    period: { start: "2025-12-28T02:00:00Z", end: "2025-12-28T04:00:00Z" },
  },
  // P008 — David Chen, Hypertensive crisis, 3-day EMERGENCY admission (L=2, A=3, C=0, E=2 → 7 MODERATE)
  {
    resourceType: "Encounter", id: "ENC-P008-ADMIT", status: "finished",
    class: { code: "IMP", display: "inpatient encounter" },
    type: [{ coding: [{ code: "EMER", display: "Emergency" }] }],
    subject: { reference: "Patient/P008" },
    period: { start: "2026-03-20T08:00:00Z", end: "2026-03-23T16:00:00Z" },
    hospitalization: { admitSource: { coding: [{ code: "emd", display: "From accident/emergency department" }] } },
  },
  {
    resourceType: "Encounter", id: "ENC-P008-ED-1", status: "finished",
    class: { code: "EMER", display: "emergency" },
    subject: { reference: "Patient/P008" },
    period: { start: "2025-12-25T10:00:00Z", end: "2025-12-25T13:00:00Z" },
  },
  {
    resourceType: "Encounter", id: "ENC-P008-ED-2", status: "finished",
    class: { code: "EMER", display: "emergency" },
    subject: { reference: "Patient/P008" },
    period: { start: "2026-02-07T14:00:00Z", end: "2026-02-07T16:00:00Z" },
  },
  // P006
  {
    resourceType: "Encounter", id: "ENC-P006-ADMIT", status: "finished",
    class: { code: "IMP", display: "inpatient encounter" },
    type: [{ coding: [{ code: "elective", display: "Elective" }] }],
    subject: { reference: "Patient/P006" },
    period: { start: "2026-03-05T09:00:00Z", end: "2026-03-07T15:00:00Z" },
    hospitalization: { admitSource: { coding: [{ code: "routin", display: "Routine" }] } },
  },
];

// ─── Lookup indexes ───────────────────────────────────────────────────────────

const patientById = new Map<string, FhirResource>(
  PATIENTS.map((r) => [r.patient["id"] as string, r.patient])
);

const conditionsByPatient = new Map<string, FhirResource[]>(
  PATIENTS.map((r) => [r.patient["id"] as string, r.conditions])
);

const medicationsByPatient = new Map<string, FhirResource[]>(
  PATIENTS.map((r) => [r.patient["id"] as string, r.medications])
);

const encountersByPatient = new Map<string, FhirResource[]>();
for (const enc of ENCOUNTERS) {
  const ref = (enc["subject"] as { reference?: string })?.reference ?? "";
  const pid = ref.replace("Patient/", "");
  const list = encountersByPatient.get(pid) ?? [];
  list.push(enc);
  encountersByPatient.set(pid, list);
}

const encounterById = new Map<string, FhirResource>(
  ENCOUNTERS.map((e) => [e["id"] as string, e])
);

// ─── Response helpers ─────────────────────────────────────────────────────────

interface LambdaFunctionUrlEvent {
  requestContext?: { http?: { method?: string } };
  rawPath?: string;
  rawQueryString?: string;
  queryStringParameters?: Record<string, string>;
}

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function fhirResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(body),
  };
}

function bundle(resources: FhirResource[]): FhirResource {
  return {
    resourceType: "Bundle",
    type: "searchset",
    total: resources.length,
    entry: resources.map((r) => ({ resource: r })),
  };
}

function notFound(detail: string): LambdaResponse {
  return fhirResponse(404, {
    resourceType: "OperationOutcome",
    issue: [{ severity: "error", code: "not-found", diagnostics: detail }],
  });
}

function methodNotAllowed(): LambdaResponse {
  return fhirResponse(405, {
    resourceType: "OperationOutcome",
    issue: [{ severity: "error", code: "not-supported", diagnostics: "Only GET is supported" }],
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const handler = async (event: LambdaFunctionUrlEvent): Promise<LambdaResponse> => {
  const method = event.requestContext?.http?.method ?? "GET";
  if (method !== "GET") return methodNotAllowed();

  // Strip /fhir prefix — path may be /fhir/Patient/P001 or /Patient/P001
  const rawPath = event.rawPath ?? "/";
  const path = rawPath.replace(/^\/fhir/, "");

  // GET /fhir/metadata — capability statement
  if (path === "/metadata" || path === "/metadata/") {
    return fhirResponse(200, {
      resourceType: "CapabilityStatement",
      status: "active",
      kind: "instance",
      fhirVersion: "4.0.1",
      format: ["application/fhir+json"],
      software: { name: "sentinel-fhir-mock", version: "1.0.0" },
    });
  }

  const qs = event.queryStringParameters ?? {};

  // ─── /Patient/{id} ──────────────────────────────────────────────────────────
  const patientMatch = /^\/Patient\/([^/]+)$/.exec(path);
  if (patientMatch) {
    const pid = patientMatch[1];
    if (!pid) return notFound("Patient id missing");
    const patient = patientById.get(pid);
    if (!patient) return notFound(`Patient/${pid} not found`);
    return fhirResponse(200, patient);
  }

  // ─── /Patient  (list all — no id) ──────────────────────────────────────────
  if (path === "/Patient" || path === "/Patient/") {
    const allPatients = PATIENTS.map((r) => r.patient);
    return fhirResponse(200, bundle(allPatients));
  }

  // ─── /Condition?patient={id} ────────────────────────────────────────────────
  if (path === "/Condition" || path === "/Condition/") {
    const pid = qs["patient"];
    if (!pid) return fhirResponse(200, bundle([]));
    const conditions = conditionsByPatient.get(pid) ?? [];
    return fhirResponse(200, bundle(conditions));
  }

  // ─── /Encounter?patient={id}  or  /Encounter/{id} ───────────────────────────
  if (path === "/Encounter" || path === "/Encounter/") {
    const pid = qs["patient"];
    if (!pid) return fhirResponse(200, bundle([]));
    const encounters = encountersByPatient.get(pid) ?? [];
    return fhirResponse(200, bundle(encounters));
  }

  const encounterMatch = /^\/Encounter\/([^/]+)$/.exec(path);
  if (encounterMatch) {
    const eid = encounterMatch[1];
    if (!eid) return notFound("Encounter id missing");
    const enc = encounterById.get(eid);
    if (!enc) return notFound(`Encounter/${eid} not found`);
    return fhirResponse(200, enc);
  }

  // ─── /MedicationRequest?patient={id} ────────────────────────────────────────
  if (path === "/MedicationRequest" || path === "/MedicationRequest/") {
    const pid = qs["patient"];
    if (!pid) return fhirResponse(200, bundle([]));
    const meds = medicationsByPatient.get(pid) ?? [];
    return fhirResponse(200, bundle(meds));
  }

  return notFound(`Resource path not found: ${path}`);
};
