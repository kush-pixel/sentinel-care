import * as dotenv from "dotenv";
import * as path from "path";
import fetch from "node-fetch";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function baseUrl(): string {
  const url = process.env["FHIR_BASE_URL"];
  if (!url) throw new Error("FHIR_BASE_URL is not set");
  return url;
}

// ─── FHIR PUT helper ──────────────────────────────────────────────────────────

async function putResource(
  resourceType: string,
  id: string,
  body: object
): Promise<boolean> {
  const url = `${baseUrl()}/${resourceType}/${id}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`  [${res.status}] PUT ${resourceType}/${id} failed:`, text.slice(0, 200));
    return false;
  }
  return true;
}

// ─── Language helper ──────────────────────────────────────────────────────────

function langCommunication(code: string) {
  return [{ language: { coding: [{ system: "urn:ietf:bcp:47", code }] } }];
}

// ─── Patient definitions ──────────────────────────────────────────────────────

const patients = [
  {
    patient: {
      resourceType: "Patient",
      id: "P001",
      name: [{ family: "Torres", given: ["Margaret"] }],
      birthDate: "1955-01-15",
      gender: "female",
      communication: langCommunication("en"),
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
      communication: langCommunication("en"),
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
      communication: langCommunication("en"),
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
      communication: langCommunication("en"),
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
      communication: langCommunication("es"),
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
      id: "P006",
      name: [{ family: "Thompson", given: ["David"] }],
      birthDate: "1952-09-12",
      gender: "male",
      communication: langCommunication("en"),
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

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function seedFhir(): Promise<void> {
  console.log("Seeding FHIR patients...\n");

  for (const { patient, conditions, medications } of patients) {
    const pid = patient.id;
    console.log(`[${pid}] Writing Patient...`);
    await putResource("Patient", pid, patient);

    for (const cond of conditions) {
      console.log(`[${pid}] Writing Condition ${cond.id}...`);
      await putResource("Condition", cond.id, cond);
    }

    for (const med of medications) {
      console.log(`[${pid}] Writing MedicationRequest ${med.id}...`);
      await putResource("MedicationRequest", med.id, med);
    }
  }

  console.log("\n── Confirmation ──────────────────────────────────────────");
  console.log(
    "patient_id | condition_code            | medications | status"
  );
  console.log(
    "───────────────────────────────────────────────────────────────"
  );

  for (const { patient, conditions, medications } of patients) {
    const pid = patient.id;
    const res = await fetch(`${baseUrl()}/Patient/${pid}`);
    const status = res.ok ? "OK" : `HTTP ${res.status}`;
    const condCode =
      conditions[0]?.code?.coding?.[0]?.code ?? "—";
    const medCount = medications.length;
    console.log(
      `${pid.padEnd(10)} | ${condCode.padEnd(25)} | ${String(medCount).padEnd(11)} | ${status}`
    );
  }
}

async function main(): Promise<void> {
  await seedFhir();
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("seed-fhir failed:", err);
    process.exit(1);
  });
}
