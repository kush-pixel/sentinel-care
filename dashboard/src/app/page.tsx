"use client";

import { useState, useEffect, useCallback } from "react";
import type { PatientRecord, DashboardStats } from "@/lib/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_STATS: DashboardStats = {
  total: 0,
  red: 0,
  yellow: 0,
  green: 0,
  incomplete: 0,
  acknowledged: 0,
  pending: 0,
};

function statusBadgeClass(status: PatientRecord["triageStatus"]): string {
  switch (status) {
    case "RED":
      return "bg-red-600 text-white";
    case "YELLOW":
      return "bg-yellow-500 text-black";
    case "GREEN":
      return "bg-green-600 text-white";
    case "INCOMPLETE":
      return "bg-slate-500 text-white";
  }
}

function cardBorderClass(p: PatientRecord): string {
  if (p.nurseAcknowledged) return "border-slate-600 bg-slate-800 opacity-60";
  switch (p.triageStatus) {
    case "RED":
      return "border-red-500 bg-red-950";
    case "YELLOW":
      return "border-yellow-500 bg-yellow-950";
    case "GREEN":
      return "border-green-600 bg-slate-800";
    case "INCOMPLETE":
      return "border-slate-600 bg-slate-800";
  }
}

function lacePillClass(riskLevel: string): string {
  switch (riskLevel.toUpperCase()) {
    case "VERY HIGH":
    case "HIGH":
      return "bg-red-800 text-red-100";
    case "MODERATE":
      return "bg-yellow-800 text-yellow-100";
    default:
      return "bg-slate-700 text-slate-200";
  }
}

function recommendationColorClass(status: PatientRecord["triageStatus"]): string {
  switch (status) {
    case "RED":
      return "text-red-400";
    case "YELLOW":
      return "text-yellow-400";
    case "GREEN":
      return "text-green-400";
    default:
      return "text-slate-300";
  }
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ─── SBAR text renderer ───────────────────────────────────────────────────────

function SbarText({
  text,
  status,
}: {
  text: string;
  status: PatientRecord["triageStatus"];
}) {
  if (!text) {
    return (
      <p className="text-slate-400 italic">No SBAR summary available.</p>
    );
  }

  const rColor = recommendationColorClass(status);
  const lines = text.split("\n");

  return (
    <div className="space-y-1 text-sm leading-relaxed">
      {lines.map((line, i) => {
        const sMatch = line.match(/^(S \(Situation\)):(.*)$/);
        const bMatch = line.match(/^(B \(Background\)):(.*)$/);
        const aMatch = line.match(/^(A \(Assessment\)):(.*)$/);
        const rMatch = line.match(/^(R \(Recommendation\)):(.*)$/);

        if (sMatch) {
          return (
            <p key={i}>
              <strong className="text-white">{sMatch[1]}:</strong>
              <span className="text-slate-200">{sMatch[2]}</span>
            </p>
          );
        }
        if (bMatch) {
          return (
            <p key={i}>
              <strong className="text-white">{bMatch[1]}:</strong>
              <span className="text-slate-200">{bMatch[2]}</span>
            </p>
          );
        }
        if (aMatch) {
          return (
            <p key={i}>
              <strong className="text-white">{aMatch[1]}:</strong>
              <span className="text-slate-200">{aMatch[2]}</span>
            </p>
          );
        }
        if (rMatch) {
          return (
            <p key={i}>
              <strong className={rColor}>{rMatch[1]}:</strong>
              <span className={rColor}>{rMatch[2]}</span>
            </p>
          );
        }
        if (line.trim() === "") return <br key={i} />;
        return (
          <p key={i} className="text-slate-300">
            {line}
          </p>
        );
      })}
    </div>
  );
}

// ─── SBAR Modal ───────────────────────────────────────────────────────────────

function SbarModal({
  patient,
  nurseId,
  onClose,
  onAcknowledge,
}: {
  patient: PatientRecord;
  nurseId: string;
  onClose: () => void;
  onAcknowledge: (p: PatientRecord) => void;
}) {
  const lc = patient.laceComponents;
  const lcText = lc
    ? `L:${lc.L} + A:${lc.A} + C:${lc.C} + E:${lc.E} = ${patient.laceScore} (${patient.laceRiskLevel})`
    : `${patient.laceScore} (${patient.laceRiskLevel})`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-slate-800 border border-slate-600 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="sticky top-0 z-10 flex items-center justify-between bg-slate-800 border-b border-slate-600 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold text-white">
              Patient {patient.patientId}
            </span>
            <span
              className={`px-2 py-0.5 rounded text-sm font-semibold ${statusBadgeClass(patient.triageStatus)}`}
            >
              {patient.triageStatus}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white text-xl font-bold w-8 h-8 flex items-center justify-center rounded hover:bg-slate-700"
          >
            ✕
          </button>
        </div>

        {/* Modal body */}
        <div className="px-6 py-5 space-y-5">
          {/* LACE breakdown */}
          <div>
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              LACE Score
            </h3>
            <span
              className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${lacePillClass(patient.laceRiskLevel)}`}
            >
              {lcText}
            </span>
          </div>

          {/* Guideline source */}
          {patient.guidelineSource && (
            <div>
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                Guideline Source
              </h3>
              <p className="text-sm text-slate-300">{patient.guidelineSource}</p>
            </div>
          )}

          {/* Broken rules */}
          {patient.brokenRules.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                Broken Rules
              </h3>
              <div className="flex flex-wrap gap-2">
                {patient.brokenRules.map((rule, i) => (
                  <code
                    key={i}
                    className="px-2 py-0.5 bg-slate-700 text-slate-200 rounded text-xs font-mono"
                  >
                    {rule}
                  </code>
                ))}
              </div>
            </div>
          )}

          {/* SBAR text */}
          <div>
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
              SBAR Clinical Summary
            </h3>
            <div className="bg-slate-900 rounded-lg p-4 border border-slate-700">
              <SbarText text={patient.sbarSummary} status={patient.triageStatus} />
            </div>
          </div>

          {/* Acknowledgement status */}
          {patient.nurseAcknowledged ? (
            <div className="text-sm text-green-400 font-medium">
              ✓ Acknowledged by {patient.acknowledgedBy} at{" "}
              {patient.acknowledgedAt
                ? new Date(patient.acknowledgedAt).toLocaleString()
                : ""}
            </div>
          ) : (
            <button
              onClick={() => onAcknowledge(patient)}
              className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-colors"
            >
              Acknowledge — {nurseId}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Patient Card ─────────────────────────────────────────────────────────────

function PatientCard({
  patient,
  nurseId,
  onViewSbar,
  onAcknowledge,
}: {
  patient: PatientRecord;
  nurseId: string;
  onViewSbar: (p: PatientRecord) => void;
  onAcknowledge: (p: PatientRecord) => void;
}) {
  const lc = patient.laceComponents;
  const laceText = lc
    ? `LACE ${patient.laceScore} · ${patient.laceRiskLevel}`
    : `LACE ${patient.laceScore} · ${patient.laceRiskLevel}`;

  return (
    <div
      className={`rounded-xl border-2 p-4 space-y-3 transition-opacity ${cardBorderClass(patient)}`}
    >
      {/* Row 1: Status + patient ID + condition + protocol badge */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`px-2 py-0.5 rounded text-xs font-bold ${statusBadgeClass(patient.triageStatus)}`}
        >
          {patient.triageStatus}
        </span>
        <span className="font-bold text-white">{patient.patientId}</span>
        {patient.conditionCode && (
          <span className="text-slate-400 text-sm">
            {patient.conditionCode}
          </span>
        )}
        {patient.protocolSource === "validated_library" && (
          <span className="px-2 py-0.5 rounded text-xs bg-green-800 text-green-200 font-medium">
            validated
          </span>
        )}
      </div>

      {/* Row 2: LACE pill */}
      <div>
        <span
          className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${lacePillClass(patient.laceRiskLevel)}`}
        >
          {laceText}
        </span>
      </div>

      {/* Row 3: Broken rules */}
      {patient.brokenRules.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {patient.brokenRules.map((rule, i) => (
            <code
              key={i}
              className="px-1.5 py-0.5 bg-slate-700 text-slate-300 rounded text-xs font-mono"
            >
              {rule}
            </code>
          ))}
        </div>
      )}

      {/* Row 4: Guideline source */}
      {patient.guidelineSource && (
        <p className="text-xs text-slate-500 truncate">{patient.guidelineSource}</p>
      )}

      {/* Row 5: Action buttons */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onViewSbar(patient)}
          className="flex-1 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium transition-colors"
        >
          View SBAR
        </button>
        {patient.nurseAcknowledged ? (
          <div className="flex-1 py-1.5 rounded bg-slate-800 text-green-400 text-sm font-medium text-center cursor-default border border-slate-700">
            ✓ {patient.acknowledgedBy ?? "Acknowledged"}
          </div>
        ) : (
          <button
            onClick={() => onAcknowledge(patient)}
            className="flex-1 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white text-sm font-medium transition-colors"
          >
            Acknowledge
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-xl border-2 border-slate-700 bg-slate-800 p-4 space-y-3 animate-pulse"
        >
          <div className="flex gap-2">
            <div className="h-5 w-16 bg-slate-700 rounded" />
            <div className="h-5 w-20 bg-slate-700 rounded" />
          </div>
          <div className="h-4 w-24 bg-slate-700 rounded-full" />
          <div className="flex gap-1">
            <div className="h-4 w-32 bg-slate-700 rounded" />
            <div className="h-4 w-24 bg-slate-700 rounded" />
          </div>
          <div className="h-3 w-48 bg-slate-700 rounded" />
          <div className="flex gap-2">
            <div className="h-8 flex-1 bg-slate-700 rounded" />
            <div className="h-8 flex-1 bg-slate-700 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Page() {
  const [patients, setPatients] = useState<PatientRecord[]>([]);
  const [stats, setStats] = useState<DashboardStats>(DEFAULT_STATS);
  const [loading, setLoading] = useState(true);
  const [selectedPatient, setSelectedPatient] = useState<PatientRecord | null>(null);
  const [nurseId, setNurseId] = useState("Nurse");
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [mounted, setMounted] = useState(false);

  const refreshInterval =
    parseInt(process.env.NEXT_PUBLIC_REFRESH_INTERVAL ?? "30000") || 30000;

  const fetchPatients = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);

    try {
      const res = await fetch("/api/patients", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        patients: PatientRecord[];
        stats: DashboardStats;
      };
      setPatients(data.patients);
      setStats(data.stats);
      setLastRefresh(new Date());
    } catch (err) {
      console.error("Failed to fetch patients:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Mark as mounted to prevent hydration mismatch on time display
  useEffect(() => setMounted(true), []);

  // Initial load + auto-refresh
  useEffect(() => {
    void fetchPatients(false);
    const interval = setInterval(() => void fetchPatients(true), refreshInterval);
    return () => clearInterval(interval);
  }, [fetchPatients, refreshInterval]);

  const handleAcknowledge = async (patient: PatientRecord) => {
    try {
      const res = await fetch(
        `/api/patients/${patient.patientId}/acknowledge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callId: patient.callId,
            acknowledgedBy: nurseId,
          }),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Optimistically update local state without closing modal
      setPatients((prev) =>
        prev.map((p) =>
          p.callId === patient.callId && p.patientId === patient.patientId
            ? {
                ...p,
                nurseAcknowledged: true,
                acknowledgedBy: nurseId,
                acknowledgedAt: new Date().toISOString(),
              }
            : p
        )
      );

      // Also update selectedPatient if it's the same record
      setSelectedPatient((prev) =>
        prev &&
        prev.callId === patient.callId &&
        prev.patientId === patient.patientId
          ? {
              ...prev,
              nurseAcknowledged: true,
              acknowledgedBy: nurseId,
              acknowledgedAt: new Date().toISOString(),
            }
          : prev
      );
    } catch (err) {
      console.error("Acknowledge failed:", err);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900">
      {/* ── Header ── */}
      <header className="sticky top-0 z-40 bg-slate-900/95 backdrop-blur border-b border-slate-700 px-4 py-3">
        <div className="max-w-7xl mx-auto flex items-center gap-4 flex-wrap">
          {/* Left: branding */}
          <div className="flex-shrink-0">
            <div className="font-bold text-lg text-white tracking-wide">
              SENTINEL VOICE
            </div>
            <div className="text-xs text-slate-400">
              Post-Discharge Triage Dashboard
            </div>
          </div>

          {/* Centre: stat pills */}
          <div className="flex items-center gap-2 flex-wrap flex-1 justify-center">
            <span className="flex items-center gap-1 px-3 py-1 rounded-full bg-red-900 border border-red-600 text-sm font-semibold text-red-200">
              🔴 {stats.red} RED
            </span>
            <span className="flex items-center gap-1 px-3 py-1 rounded-full bg-yellow-900 border border-yellow-600 text-sm font-semibold text-yellow-200">
              🟡 {stats.yellow} YELLOW
            </span>
            <span className="flex items-center gap-1 px-3 py-1 rounded-full bg-green-900 border border-green-600 text-sm font-semibold text-green-200">
              🟢 {stats.green} GREEN
            </span>
            <span className="flex items-center gap-1 px-3 py-1 rounded-full bg-slate-700 border border-slate-500 text-sm font-semibold text-slate-300">
              ⚪ {stats.incomplete} INCOMPLETE
            </span>
          </div>

          {/* Right: refresh info + nurse ID */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="text-right">
              <div className="text-xs text-slate-400">
                Last updated:{" "}
                {mounted ? formatTime(lastRefresh) : "--:--:-- --"}
              </div>
              {refreshing && (
                <div className="text-xs text-blue-400 animate-pulse">
                  Refreshing…
                </div>
              )}
            </div>
            <input
              type="text"
              value={nurseId}
              onChange={(e) => setNurseId(e.target.value)}
              placeholder="Nurse ID"
              className="w-28 px-2 py-1 rounded bg-slate-700 border border-slate-600 text-white text-sm focus:outline-none focus:border-blue-500"
              title="Enter your nurse ID for acknowledgements"
            />
          </div>
        </div>
      </header>

      {/* ── Main content ── */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {loading ? (
          <LoadingSkeleton />
        ) : patients.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="text-5xl mb-4">📋</div>
            <h2 className="text-xl font-semibold text-slate-300">
              No triage results yet
            </h2>
            <p className="text-slate-500 mt-2 text-sm">
              Patient records will appear here once post-discharge calls are
              completed.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {patients.map((patient) => (
              <PatientCard
                key={`${patient.callId}-${patient.patientId}`}
                patient={patient}
                nurseId={nurseId}
                onViewSbar={setSelectedPatient}
                onAcknowledge={handleAcknowledge}
              />
            ))}
          </div>
        )}
      </main>

      {/* ── SBAR Modal ── */}
      {selectedPatient && (
        <SbarModal
          patient={selectedPatient}
          nurseId={nurseId}
          onClose={() => setSelectedPatient(null)}
          onAcknowledge={handleAcknowledge}
        />
      )}
    </div>
  );
}
