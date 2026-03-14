import * as dotenv from "dotenv";
import * as path from "path";
import fetch from "node-fetch";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function baseUrl(): string {
  const url = process.env["FHIR_BASE_URL"];
  if (!url) throw new Error("FHIR_BASE_URL is not set");
  return url;
}

async function putEncounter(id: string, body: object): Promise<boolean> {
  const url = `${baseUrl()}/Encounter/${id}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`  [${res.status}] PUT Encounter/${id}:`, text.slice(0, 200));
    return false;
  }
  return true;
}

// ─── Encounter definitions ────────────────────────────────────────────────────

const encounters: Array<{ id: string; body: object }> = [
  // P001
  {
    id: "ENC-P001-ADMIT",
    body: {
      resourceType: "Encounter",
      id: "ENC-P001-ADMIT",
      status: "finished",
      class: { code: "IMP", display: "inpatient encounter" },
      type: [{ coding: [{ code: "EMER", display: "Emergency" }] }],
      subject: { reference: "Patient/P001" },
      period: { start: "2026-02-28T08:00:00Z", end: "2026-03-06T14:00:00Z" },
      hospitalization: {
        admitSource: {
          coding: [{ code: "emd", display: "From accident/emergency department" }],
        },
      },
    },
  },
  {
    id: "ENC-P001-ED-1",
    body: {
      resourceType: "Encounter",
      id: "ENC-P001-ED-1",
      status: "finished",
      class: { code: "EMER", display: "emergency" },
      subject: { reference: "Patient/P001" },
      period: { start: "2025-10-15T20:00:00Z", end: "2025-10-15T23:00:00Z" },
    },
  },
  {
    id: "ENC-P001-ED-2",
    body: {
      resourceType: "Encounter",
      id: "ENC-P001-ED-2",
      status: "finished",
      class: { code: "EMER", display: "emergency" },
      subject: { reference: "Patient/P001" },
      period: { start: "2025-12-03T15:00:00Z", end: "2025-12-03T18:00:00Z" },
    },
  },
  // P002
  {
    id: "ENC-P002-ADMIT",
    body: {
      resourceType: "Encounter",
      id: "ENC-P002-ADMIT",
      status: "finished",
      class: { code: "IMP", display: "inpatient encounter" },
      type: [{ coding: [{ code: "elective", display: "Elective" }] }],
      subject: { reference: "Patient/P002" },
      period: { start: "2026-03-05T07:00:00Z", end: "2026-03-07T11:00:00Z" },
      hospitalization: {
        admitSource: {
          coding: [{ code: "routin", display: "Routine" }],
        },
      },
    },
  },
  // P003
  {
    id: "ENC-P003-ADMIT",
    body: {
      resourceType: "Encounter",
      id: "ENC-P003-ADMIT",
      status: "finished",
      class: { code: "IMP", display: "inpatient encounter" },
      type: [{ coding: [{ code: "EMER", display: "Emergency" }] }],
      subject: { reference: "Patient/P003" },
      period: { start: "2026-03-05T14:00:00Z", end: "2026-03-07T10:00:00Z" },
      hospitalization: {
        admitSource: {
          coding: [{ code: "emd", display: "From accident/emergency department" }],
        },
      },
    },
  },
  {
    id: "ENC-P003-ED-1",
    body: {
      resourceType: "Encounter",
      id: "ENC-P003-ED-1",
      status: "finished",
      class: { code: "EMER", display: "emergency" },
      subject: { reference: "Patient/P003" },
      period: { start: "2025-11-20T18:00:00Z", end: "2025-11-20T21:00:00Z" },
    },
  },
  // P004
  {
    id: "ENC-P004-ADMIT",
    body: {
      resourceType: "Encounter",
      id: "ENC-P004-ADMIT",
      status: "finished",
      class: { code: "IMP", display: "inpatient encounter" },
      type: [{ coding: [{ code: "EMER", display: "Emergency" }] }],
      subject: { reference: "Patient/P004" },
      period: { start: "2026-03-04T22:00:00Z", end: "2026-03-07T09:00:00Z" },
      hospitalization: {
        admitSource: {
          coding: [{ code: "emd", display: "From accident/emergency department" }],
        },
      },
    },
  },
  {
    id: "ENC-P004-ED-1",
    body: {
      resourceType: "Encounter",
      id: "ENC-P004-ED-1",
      status: "finished",
      class: { code: "EMER", display: "emergency" },
      subject: { reference: "Patient/P004" },
      period: { start: "2025-09-10T21:00:00Z", end: "2025-09-10T23:00:00Z" },
    },
  },
  {
    id: "ENC-P004-ED-2",
    body: {
      resourceType: "Encounter",
      id: "ENC-P004-ED-2",
      status: "finished",
      class: { code: "EMER", display: "emergency" },
      subject: { reference: "Patient/P004" },
      period: { start: "2025-11-05T19:00:00Z", end: "2025-11-05T21:00:00Z" },
    },
  },
  {
    id: "ENC-P004-ED-3",
    body: {
      resourceType: "Encounter",
      id: "ENC-P004-ED-3",
      status: "finished",
      class: { code: "EMER", display: "emergency" },
      subject: { reference: "Patient/P004" },
      period: { start: "2026-01-18T23:00:00Z", end: "2026-01-19T01:00:00Z" },
    },
  },
  // P005
  {
    id: "ENC-P005-ADMIT",
    body: {
      resourceType: "Encounter",
      id: "ENC-P005-ADMIT",
      status: "finished",
      class: { code: "IMP", display: "inpatient encounter" },
      type: [{ coding: [{ code: "EMER", display: "Emergency" }] }],
      subject: { reference: "Patient/P005" },
      period: { start: "2026-03-02T03:00:00Z", end: "2026-03-06T16:00:00Z" },
      hospitalization: {
        admitSource: {
          coding: [{ code: "emd", display: "From accident/emergency department" }],
        },
      },
    },
  },
  {
    id: "ENC-P005-ED-1",
    body: {
      resourceType: "Encounter",
      id: "ENC-P005-ED-1",
      status: "finished",
      class: { code: "EMER", display: "emergency" },
      subject: { reference: "Patient/P005" },
      period: { start: "2025-12-28T02:00:00Z", end: "2025-12-28T04:00:00Z" },
    },
  },
  // P006
  {
    id: "ENC-P006-ADMIT",
    body: {
      resourceType: "Encounter",
      id: "ENC-P006-ADMIT",
      status: "finished",
      class: { code: "IMP", display: "inpatient encounter" },
      type: [{ coding: [{ code: "elective", display: "Elective" }] }],
      subject: { reference: "Patient/P006" },
      period: { start: "2026-03-05T09:00:00Z", end: "2026-03-07T15:00:00Z" },
      hospitalization: {
        admitSource: {
          coding: [{ code: "routin", display: "Routine" }],
        },
      },
    },
  },
];

// ─── Admission encounters per patient (for verification) ──────────────────────

const admissionEncounterIds: Record<string, string> = {
  P001: "ENC-P001-ADMIT",
  P002: "ENC-P002-ADMIT",
  P003: "ENC-P003-ADMIT",
  P004: "ENC-P004-ADMIT",
  P005: "ENC-P005-ADMIT",
  P006: "ENC-P006-ADMIT",
};

const edVisitCounts: Record<string, number> = {
  P001: 2,
  P002: 0,
  P003: 1,
  P004: 3,
  P005: 1,
  P006: 0,
};

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function seedEncounters(): Promise<void> {
  console.log("Seeding Encounter resources...\n");

  let successCount = 0;
  let failCount = 0;

  for (const enc of encounters) {
    const ok = await putEncounter(enc.id, enc.body);
    if (ok) {
      console.log(`  ✓ PUT Encounter/${enc.id}`);
      successCount++;
    } else {
      failCount++;
    }
  }

  console.log(`\nSeeded ${successCount} encounters (${failCount} failed).\n`);

  // Verify by fetching back each admission encounter
  console.log("Verification:");
  console.log(
    "patient_id | enc_id              | admission_type | los_days | ed_visits | status"
  );
  console.log(
    "───────────────────────────────────────────────────────────────────────────────────"
  );

  const PATIENT_IDS = ["P001", "P002", "P003", "P004", "P005", "P006"];

  for (const pid of PATIENT_IDS) {
    const encId = admissionEncounterIds[pid];
    if (!encId) continue;

    try {
      const res = await fetch(`${baseUrl()}/Encounter/${encId}`);
      if (!res.ok) {
        console.log(`${pid.padEnd(10)} | ${encId.padEnd(19)} | ERROR: ${res.status}`);
        continue;
      }

      const enc = (await res.json()) as {
        status?: string;
        period?: { start?: string; end?: string };
        type?: Array<{ coding?: Array<{ code?: string }> }>;
        hospitalization?: { admitSource?: { coding?: Array<{ code?: string }> } };
      };

      const start = enc.period?.start ?? "";
      const end = enc.period?.end ?? "";
      const losDays =
        start && end
          ? Math.round(
              (new Date(end).getTime() - new Date(start).getTime()) /
                (1000 * 60 * 60 * 24)
            )
          : 0;

      const admitCode =
        enc.hospitalization?.admitSource?.coding?.[0]?.code ?? "";
      const typeCode = enc.type?.[0]?.coding?.[0]?.code ?? "";
      const admissionType =
        admitCode.toLowerCase().includes("emd") || typeCode === "EMER"
          ? "EMERGENCY"
          : "PLANNED";

      const edVisits = edVisitCounts[pid] ?? 0;
      const status = enc.status ?? "unknown";

      console.log(
        `${pid.padEnd(10)} | ${encId.padEnd(19)} | ${admissionType.padEnd(14)} | ${String(losDays).padEnd(8)} | ${String(edVisits).padEnd(9)} | ${status}`
      );
    } catch (err: unknown) {
      console.log(
        `${pid.padEnd(10)} | ${encId.padEnd(19)} | ERROR: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

async function main(): Promise<void> { await seedEncounters(); }

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("seed-encounters failed:", err);
    process.exit(1);
  });
}
