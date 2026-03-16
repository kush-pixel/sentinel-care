"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  PatientRecord,
  DashboardStats,
  ProtocolReviewRecord,
  ProtocolCondition,
  ReviewStats,
} from "@/lib/types";

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_STATS: DashboardStats = {
  total: 0,
  red: 0,
  yellow: 0,
  green: 0,
  incomplete: 0,
  acknowledged: 0,
  pending: 0,
};

const DEFAULT_REVIEW_STATS: ReviewStats = {
  total: 0,
  pending: 0,
  approved: 0,
  rejected: 0,
  autoApproved: 0,
};

// ─── Rule → natural language ──────────────────────────────────────────────────
// Mirrors the server-side convertRulesToNaturalLanguage in the summarizer so the
// dashboard card badges read the same way as the SBAR assessment text.

function ruleToNaturalLanguage(rule: string): string {
  const m = rule.match(/^(\S+)\s*(>=|<=|>|<|==)\s*(.+)$/);
  if (!m) return rule;
  const [, varRaw, op, threshRaw] = m;
  const varName = varRaw.replace(/_/g, " ");
  const threshold = threshRaw.trim();
  if (threshold === "true")  return `${varName} is present`;
  if (threshold === "false") return `${varName} is absent`;
  const opText =
    op === ">=" ? "is at least" :
    op === ">"  ? "exceeds"     :
    op === "<=" ? "is at most"  :
    op === "<"  ? "is below"    : "is";
  return `${varName} ${opText} ${threshold}`;
}

// ─── Triage helpers ───────────────────────────────────────────────────────────

function statusBadgeClass(status: PatientRecord["triageStatus"]): string {
  switch (status) {
    case "RED":        return "bg-red-600 text-white";
    case "YELLOW":     return "bg-yellow-500 text-black";
    case "GREEN":      return "bg-green-600 text-white";
    case "INCOMPLETE": return "bg-slate-500 text-white";
  }
}

function cardBorderClass(p: PatientRecord): string {
  if (p.nurseAcknowledged) return "border-slate-600 bg-slate-800 opacity-60";
  switch (p.triageStatus) {
    case "RED":        return "border-red-500 bg-red-950";
    case "YELLOW":     return "border-yellow-500 bg-yellow-950";
    case "GREEN":      return "border-green-600 bg-slate-800";
    case "INCOMPLETE": return "border-slate-600 bg-slate-800";
  }
}

function lacePillClass(riskLevel: string): string {
  switch (riskLevel.toUpperCase()) {
    case "VERY HIGH":
    case "HIGH":     return "bg-red-800 text-red-100";
    case "MODERATE": return "bg-yellow-800 text-yellow-100";
    default:         return "bg-slate-700 text-slate-200";
  }
}

function recommendationColorClass(
  status: PatientRecord["triageStatus"]
): string {
  switch (status) {
    case "RED":    return "text-red-400";
    case "YELLOW": return "text-yellow-400";
    case "GREEN":  return "text-green-400";
    default:       return "text-slate-300";
  }
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ─── Review helpers ───────────────────────────────────────────────────────────

function confidenceBarClass(score: number): string {
  if (score < 0.70) return "bg-red-500";
  if (score <= 0.85) return "bg-amber-500";
  return "bg-green-500";
}

function confidenceLabelClass(score: number): string {
  if (score < 0.70) return "text-red-400";
  if (score <= 0.85) return "text-amber-400";
  return "text-green-400";
}

function flagColorEmoji(flagColor: string | undefined): string {
  switch ((flagColor ?? "").toUpperCase()) {
    case "RED":    return "🔴";
    case "YELLOW": return "🟡";
    case "GREEN":  return "🟢";
    default:       return "⚪";
  }
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
    return <p className="text-slate-400 italic">No SBAR summary available.</p>;
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
        if (sMatch) return (
          <p key={i}><strong className="text-white">{sMatch[1]}:</strong><span className="text-slate-200">{sMatch[2]}</span></p>
        );
        if (bMatch) return (
          <p key={i}><strong className="text-white">{bMatch[1]}:</strong><span className="text-slate-200">{bMatch[2]}</span></p>
        );
        if (aMatch) return (
          <p key={i}><strong className="text-white">{aMatch[1]}:</strong><span className="text-slate-200">{aMatch[2]}</span></p>
        );
        if (rMatch) return (
          <p key={i}><strong className={rColor}>{rMatch[1]}:</strong><span className={rColor}>{rMatch[2]}</span></p>
        );
        if (line.trim() === "") return <br key={i} />;
        return <p key={i} className="text-slate-300">{line}</p>;
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
        <div className="sticky top-0 z-10 flex items-center justify-between bg-slate-800 border-b border-slate-600 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold text-white">
              {patient.patientName ? `${patient.patientName} (${patient.patientId})` : patient.patientId}
            </span>
            <span className={`px-2 py-0.5 rounded text-sm font-semibold ${statusBadgeClass(patient.triageStatus)}`}>
              {patient.triageStatus}
            </span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl font-bold w-8 h-8 flex items-center justify-center rounded hover:bg-slate-700">✕</button>
        </div>
        <div className="px-6 py-5 space-y-5">
          <div>
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">LACE Score</h3>
            <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${lacePillClass(patient.laceRiskLevel)}`}>{lcText}</span>
          </div>
          {patient.guidelineSource && (
            <div>
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Guideline Source</h3>
              <p className="text-sm text-slate-300">{patient.guidelineSource}</p>
              {patient.ruleVersionId && (
                <p className="text-xs text-slate-500 mt-1">
                  Rule version: {patient.ruleVersionId.includes("#v") ? `v${patient.ruleVersionId.split("#v")[1]}` : patient.ruleVersionId}
                  {patient.ruleEffectiveFrom
                    ? ` (effective ${new Date(patient.ruleEffectiveFrom).toLocaleDateString()})`
                    : ""}
                </p>
              )}
            </div>
          )}
          {patient.brokenRules.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Broken Rules</h3>
              <div className="flex flex-wrap gap-2">
                {patient.brokenRules.map((rule, i) => (
                  <span key={i} className="px-2 py-0.5 bg-slate-700 text-slate-200 rounded text-xs">{ruleToNaturalLanguage(rule)}</span>
                ))}
              </div>
            </div>
          )}
          <div>
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">SBAR Clinical Summary</h3>
            <div className="bg-slate-900 rounded-lg p-4 border border-slate-700">
              <SbarText text={patient.sbarSummary} status={patient.triageStatus} />
            </div>
          </div>
          {patient.nurseAcknowledged ? (
            <div className="text-sm text-green-400 font-medium">
              ✓ Acknowledged by {patient.acknowledgedBy} at{" "}
              {patient.acknowledgedAt ? new Date(patient.acknowledgedAt).toLocaleString() : ""}
            </div>
          ) : (
            <button onClick={() => onAcknowledge(patient)} className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-colors">
              Acknowledge — {nurseId}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Protocol Review Modal ────────────────────────────────────────────────────

function ReviewModal({
  review,
  nurseId,
  onClose,
  onApprove,
  onReject,
}: {
  review: ProtocolReviewRecord;
  nurseId: string;
  onClose: () => void;
  onApprove: (review: ProtocolReviewRecord, notes: string) => Promise<void>;
  onReject: (review: ProtocolReviewRecord, reason: string, notes: string) => Promise<void>;
}) {
  const [notes, setNotes] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [rejectionError, setRejectionError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const lc = review.laceComponents;
  const lcText = lc
    ? `L:${lc.L} + A:${lc.A} + C:${lc.C} + E:${lc.E} = ${review.laceScore} (${review.laceRiskLevel})`
    : `${review.laceScore} (${review.laceRiskLevel})`;

  const handleApprove = async () => {
    setSubmitting(true);
    await onApprove(review, notes);
    setSubmitting(false);
  };

  const handleReject = async () => {
    if (!rejectionReason.trim()) {
      setRejectionError("Rejection reason is required.");
      return;
    }
    setRejectionError("");
    setSubmitting(true);
    await onReject(review, rejectionReason, notes);
    setSubmitting(false);
  };

  const conditions: ProtocolCondition[] =
    review.protocol?.root_node?.conditions ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-xl bg-slate-800 border border-slate-600 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between bg-slate-800 border-b border-slate-600 px-6 py-4">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-lg font-bold text-white">Protocol Review — Patient {review.patientId}</span>
            <span className="px-2 py-0.5 rounded bg-amber-800 text-amber-200 text-sm font-semibold">PENDING</span>
            <span className={`text-sm font-bold ${confidenceLabelClass(review.confidenceScore)}`}>
              Confidence: {Math.round(review.confidenceScore * 100)}%
            </span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl font-bold w-8 h-8 flex items-center justify-center rounded hover:bg-slate-700">✕</button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Section 0: Regeneration banner (shown above everything when this is a revised protocol) */}
          {review.isRegeneration && (
            <div className="rounded-lg border border-amber-600 bg-amber-950 p-4">
              <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-2">
                ↻ REVISED PROTOCOL
              </h3>
              <p className="text-sm text-amber-100 mb-2">
                This protocol was regenerated in response to clinical feedback:
              </p>
              {review.regenerationReason && (
                <p className="text-sm text-amber-200 italic mb-2">
                  &ldquo;{review.regenerationReason}&rdquo;
                </p>
              )}
              {review.previousReviewId && (
                <p className="text-xs text-amber-500">
                  Previous review: {review.previousReviewId}
                </p>
              )}
            </div>
          )}

          {/* Section 1: Why needs review */}
          {review.pendingReason && (
            <div className="rounded-lg border border-amber-700 bg-amber-950/50 p-4">
              <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-2">Why This Needs Review</h3>
              <p className="text-sm text-amber-200 italic">{review.pendingReason}</p>
            </div>
          )}

          {/* Section 2: LACE breakdown */}
          <div>
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">LACE Score</h3>
            <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${lacePillClass(review.laceRiskLevel)}`}>
              {lcText}
            </span>
          </div>

          {/* Section 3: Protocol questions table */}
          {conditions.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                Proposed Protocol — {review.protocol?.question_priority?.length ?? 0} questions
              </h3>
              {review.ruleVersionId && (
                <p className="text-xs text-amber-400 font-medium mb-3">
                  Protocol generated using rule {review.ruleVersionId.includes("#v") ? `v${review.ruleVersionId.split("#v")[1]}` : review.ruleVersionId}
                  {review.ruleEffectiveFrom
                    ? ` (effective ${new Date(review.ruleEffectiveFrom).toLocaleDateString()})`
                    : ""}
                </p>
              )}
              <div className="overflow-x-auto rounded-lg border border-slate-700">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-700/50 text-slate-400 text-xs uppercase">
                      <th className="text-left px-3 py-2">Variable</th>
                      <th className="text-left px-3 py-2">Operator</th>
                      <th className="text-left px-3 py-2">Threshold</th>
                      <th className="text-left px-3 py-2">Weight</th>
                      <th className="text-left px-3 py-2">Flag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {conditions.map((c, i) => (
                      <tr key={i} className="border-t border-slate-700 hover:bg-slate-700/30">
                        <td className="px-3 py-2 font-mono text-slate-200">{c.variable}</td>
                        <td className="px-3 py-2 text-slate-400">{c.operator}</td>
                        <td className="px-3 py-2 text-slate-300">{String(c.threshold)}</td>
                        <td className="px-3 py-2 text-slate-300">{c.weight}</td>
                        <td className="px-3 py-2">
                          {flagColorEmoji(c.flag_color)}{" "}
                          <span className="text-slate-400">{c.flag_color ?? "—"}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Weighted threshold: {review.protocol?.root_node?.weighted_threshold} · Logic: {review.protocol?.root_node?.logic}
              </p>
            </div>
          )}

          {/* Section 4: Approve or Reject */}
          <div className="border-t border-slate-700 pt-5 space-y-4">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Review Decision</h3>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Review Notes (optional)</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add clinical notes or observations…"
                rows={2}
                className="w-full px-3 py-2 rounded bg-slate-700 border border-slate-600 text-white text-sm resize-none focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Rejection Reason{" "}
                <span className="text-slate-500">(required to reject)</span>
              </label>
              <textarea
                value={rejectionReason}
                onChange={(e) => {
                  setRejectionReason(e.target.value);
                  if (e.target.value.trim()) setRejectionError("");
                }}
                placeholder="Explain why this protocol is being rejected…"
                rows={2}
                className={`w-full px-3 py-2 rounded bg-slate-700 border text-white text-sm resize-none focus:outline-none ${rejectionError ? "border-red-500" : "border-slate-600 focus:border-blue-500"}`}
              />
              {rejectionError && (
                <p className="text-xs text-red-400 mt-1">{rejectionError}</p>
              )}
            </div>

            {(review.regenerationCount ?? 0) >= 3 && (
              <div className="rounded-lg border border-amber-600 bg-amber-950/60 px-4 py-3 text-sm text-amber-200">
                ⚠ This protocol has been revised {review.regenerationCount} times. Please escalate to Clinical Director.
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => void handleApprove()}
                disabled={submitting}
                className="flex-1 py-2.5 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white font-semibold transition-colors text-sm"
              >
                ✓ Approve Protocol
                <span className="block text-xs font-normal opacity-75">{nurseId}</span>
              </button>
              <button
                onClick={() => void handleReject()}
                disabled={submitting || (review.regenerationCount ?? 0) >= 3}
                className="flex-1 py-2.5 rounded-lg bg-red-800 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold transition-colors text-sm"
              >
                ✗ Reject Protocol
                <span className="block text-xs font-normal opacity-75">
                  {(review.regenerationCount ?? 0) >= 3 ? "escalate to Clinical Director" : "reason required above"}
                </span>
              </button>
            </div>
          </div>
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
  const laceText = `LACE ${patient.laceScore} · ${patient.laceRiskLevel}`;
  return (
    <div className={`rounded-xl border-2 p-4 space-y-3 transition-opacity ${cardBorderClass(patient)}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`px-2 py-0.5 rounded text-xs font-bold ${statusBadgeClass(patient.triageStatus)}`}>
          {patient.triageStatus}
        </span>
        <span className="font-bold text-white">
          {patient.patientName ? `${patient.patientName} (${patient.patientId})` : patient.patientId}
        </span>
        {patient.conditionCode && <span className="text-slate-400 text-sm">{patient.conditionCode}</span>}
        {patient.protocolSource === "validated_library" && (
          <span className="px-2 py-0.5 rounded text-xs bg-green-800 text-green-200 font-medium">validated</span>
        )}
      </div>
      <div>
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${lacePillClass(patient.laceRiskLevel)}`}>
          {laceText}
        </span>
      </div>
      {patient.brokenRules.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {patient.brokenRules.map((rule, i) => (
            <span key={i} className="px-1.5 py-0.5 bg-slate-700 text-slate-300 rounded text-xs">{ruleToNaturalLanguage(rule)}</span>
          ))}
        </div>
      )}
      {patient.guidelineSource && (
        <p className="text-xs text-slate-500 truncate">{patient.guidelineSource}</p>
      )}
      <div className="flex gap-2 pt-1">
        <button onClick={() => onViewSbar(patient)} className="flex-1 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium transition-colors">
          View SBAR
        </button>
        {patient.nurseAcknowledged ? (
          <div className="flex-1 py-1.5 rounded bg-slate-800 text-green-400 text-sm font-medium text-center cursor-default border border-slate-700">
            ✓ {patient.acknowledgedBy ?? "Acknowledged"}
          </div>
        ) : (
          <button onClick={() => onAcknowledge(patient)} className="flex-1 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white text-sm font-medium transition-colors">
            Acknowledge
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Protocol Review Card ─────────────────────────────────────────────────────

function ReviewCard({
  review,
  onOpenModal,
  onQuickApprove,
}: {
  review: ProtocolReviewRecord;
  onOpenModal: (r: ProtocolReviewRecord) => void;
  onQuickApprove: (r: ProtocolReviewRecord) => void;
}) {
  const isPending = review.status === "PENDING_REVIEW";
  const isApproved = review.status === "APPROVED" || review.status === "AUTO_APPROVED";
  const isRejected = review.status === "REJECTED";

  const cardClass = isPending
    ? "border-amber-500 bg-amber-950"
    : isApproved
    ? "border-green-600 bg-slate-800"
    : isRejected
    ? "border-red-800 bg-slate-800"
    : "border-slate-600 bg-slate-800";

  const questions = review.protocol?.question_priority ?? [];
  const pct = Math.round(review.confidenceScore * 100);

  return (
    <div className={`rounded-xl border-2 p-4 space-y-3 ${cardClass}`}>
      {/* Row 1: Status badge + patient + condition + source badge + regeneration badges */}
      <div className="flex items-center gap-2 flex-wrap">
        {isPending && (
          <span className="px-2 py-0.5 rounded text-xs font-bold bg-amber-700 text-amber-100">
            PENDING REVIEW
          </span>
        )}
        {isApproved && (
          <span className="px-2 py-0.5 rounded text-xs font-bold bg-green-700 text-green-100">
            {review.status === "AUTO_APPROVED" ? "AUTO-APPROVED" : "APPROVED"}
          </span>
        )}
        {isRejected && (
          <span className="px-2 py-0.5 rounded text-xs font-bold bg-red-700 text-red-100">REJECTED</span>
        )}
        <span className="font-bold text-white">{review.patientId}</span>
        {review.conditionCode && (
          <span className="text-slate-400 text-sm">{review.conditionCode}</span>
        )}
        {review.protocolSource === "validated_library" && (
          <span className="px-2 py-0.5 rounded text-xs bg-green-800 text-green-200 font-medium">validated</span>
        )}
        {review.isRegeneration && (
          <span className="px-2 py-0.5 rounded text-xs font-bold bg-amber-700 text-amber-100">
            ↻ {(review.regenerationCount ?? 1) > 1 ? `REVISION ${review.regenerationCount}` : "REVISED PROTOCOL"}
          </span>
        )}
      </div>

      {/* Row 2: Confidence bar */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-slate-400">Confidence</span>
          <span className={`text-xs font-bold ${confidenceLabelClass(review.confidenceScore)}`}>
            {pct}%{pct < 70 ? " — below threshold" : ""}
          </span>
        </div>
        <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${confidenceBarClass(review.confidenceScore)}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {review.previousReviewId && (
          <p className="text-xs text-slate-500 italic mt-1">
            Revised after rejection: {review.previousReviewId}
          </p>
        )}
      </div>

      {/* Row 3: Regeneration context box (PENDING + regenerated) */}
      {isPending && review.isRegeneration && review.regenerationReason && (
        <div className="rounded-lg border border-amber-700 bg-amber-950/60 px-3 py-2 space-y-0.5">
          <p className="text-xs font-semibold text-amber-400">↻ Revised after rejection</p>
          <p className="text-xs text-amber-200 italic leading-relaxed">
            Previous feedback: &ldquo;{review.regenerationReason}&rdquo;
          </p>
        </div>
      )}

      {/* Row 3b: Pending reason (non-regenerated cards only) */}
      {isPending && review.pendingReason && !review.isRegeneration && (
        <p className="text-xs text-slate-400 italic leading-relaxed">{review.pendingReason}</p>
      )}

      {/* Approved info */}
      {isApproved && review.reviewedBy && (
        <p className="text-xs text-green-400">
          ✓ Approved by <strong>{review.reviewedBy}</strong>
          {review.reviewedAt ? ` · ${new Date(review.reviewedAt).toLocaleString()}` : ""}
        </p>
      )}

      {/* Rejected info */}
      {isRejected && review.rejectionReason && (
        <p className="text-xs text-red-400 italic">
          ✗ Rejected — {review.rejectionReason}
        </p>
      )}

      {/* Row 4: LACE pill */}
      <div>
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${lacePillClass(review.laceRiskLevel)}`}>
          LACE {review.laceScore} · {review.laceRiskLevel}
        </span>
      </div>

      {/* Row 5: Protocol questions as tags */}
      {questions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {questions.map((q, i) => (
            <span key={i} className="px-1.5 py-0.5 bg-slate-700 text-slate-300 rounded text-xs">
              {q}
            </span>
          ))}
        </div>
      )}

      {/* Row 6: Action buttons (PENDING only) */}
      {isPending && (
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => onOpenModal(review)}
            className="flex-1 py-1.5 rounded bg-amber-700 hover:bg-amber-600 text-white text-sm font-medium transition-colors"
          >
            Review Protocol
          </button>
          <button
            onClick={() => onQuickApprove(review)}
            className="flex-1 py-1.5 rounded bg-green-800 hover:bg-green-700 text-white text-sm font-medium transition-colors"
          >
            Quick Approve
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="rounded-xl border-2 border-slate-700 bg-slate-800 p-4 space-y-3 animate-pulse">
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

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({
  message,
  type,
}: {
  message: string;
  type: "success" | "error" | "warning";
}) {
  const cls =
    type === "success"
      ? "bg-green-800 border border-green-600 text-green-100"
      : type === "warning"
      ? "bg-amber-800 border border-amber-600 text-amber-100"
      : "bg-red-800 border border-red-600 text-red-100";
  const icon = type === "success" ? "✓ " : type === "warning" ? "⚠ " : "✗ ";
  return (
    <div className={`fixed top-4 right-4 z-[60] max-w-sm px-4 py-3 rounded-lg shadow-xl text-sm font-medium transition-all ${cls}`}>
      {icon}{message}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Page() {
  // ── Existing state ──
  const [patients, setPatients] = useState<PatientRecord[]>([]);
  const [stats, setStats] = useState<DashboardStats>(DEFAULT_STATS);
  const [loading, setLoading] = useState(true);
  const [selectedPatient, setSelectedPatient] = useState<PatientRecord | null>(null);
  const [nurseId, setNurseId] = useState("Nurse");
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [mounted, setMounted] = useState(false);

  // ── New state ──
  const [activeTab, setActiveTab] = useState<"triage" | "protocols">("triage");
  const [reviews, setReviews] = useState<ProtocolReviewRecord[]>([]);
  const [reviewStats, setReviewStats] = useState<ReviewStats>(DEFAULT_REVIEW_STATS);
  const [selectedReview, setSelectedReview] = useState<ProtocolReviewRecord | null>(null);
  const [pendingProtocolCount, setPendingProtocolCount] = useState<number | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "warning" } | null>(null);

  const refreshInterval =
    parseInt(process.env.NEXT_PUBLIC_REFRESH_INTERVAL ?? "30000") || 30000;

  // ── Data fetchers ──
  const fetchPatients = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const res = await fetch("/api/patients", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { patients: PatientRecord[]; stats: DashboardStats; pendingProtocolCount?: number };
      setPatients(data.patients);
      setStats(data.stats);
      if (data.pendingProtocolCount !== undefined) {
        setPendingProtocolCount(data.pendingProtocolCount);
      }
      setLastRefresh(new Date());
    } catch (err) {
      console.error("Failed to fetch patients:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const fetchReviews = useCallback(async () => {
    try {
      const res = await fetch("/api/protocols", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { reviews: ProtocolReviewRecord[]; stats: ReviewStats };
      setReviews(data.reviews);
      setReviewStats(data.stats);
    } catch (err) {
      console.error("Failed to fetch reviews:", err);
    }
  }, []);

  // ── Toast auto-dismiss ──
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => setMounted(true), []);

  // ── Initial load + auto-refresh (both tabs) ──
  useEffect(() => {
    void fetchPatients(false);
    void fetchReviews();
    const interval = setInterval(() => {
      void fetchPatients(true);
      void fetchReviews();
    }, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchPatients, fetchReviews, refreshInterval]);

  // ── Triage handlers ──
  const handleAcknowledge = async (patient: PatientRecord) => {
    try {
      const res = await fetch(`/api/patients/${patient.patientId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId: patient.callId, acknowledgedBy: nurseId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPatients((prev) =>
        prev.map((p) =>
          p.callId === patient.callId && p.patientId === patient.patientId
            ? { ...p, nurseAcknowledged: true, acknowledgedBy: nurseId, acknowledgedAt: new Date().toISOString() }
            : p
        )
      );
      setSelectedPatient((prev) =>
        prev && prev.callId === patient.callId && prev.patientId === patient.patientId
          ? { ...prev, nurseAcknowledged: true, acknowledgedBy: nurseId, acknowledgedAt: new Date().toISOString() }
          : prev
      );
    } catch (err) {
      console.error("Acknowledge failed:", err);
    }
  };

  // ── Protocol review handlers ──
  const handleApprove = async (review: ProtocolReviewRecord, notes: string) => {
    try {
      const res = await fetch(`/api/protocols/${review.reviewId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId: review.patientId, reviewedBy: nurseId, reviewNotes: notes || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setToast({ message: `Protocol approved — call can now proceed for Patient ${review.patientId}`, type: "success" });
      setSelectedReview(null);
      await fetchReviews();
    } catch (err) {
      console.error("Approve failed:", err);
      setToast({ message: "Failed to approve protocol", type: "error" });
    }
  };

  const handleReject = async (review: ProtocolReviewRecord, reason: string, notes: string) => {
    try {
      const res = await fetch(`/api/protocols/${review.reviewId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId: review.patientId, reviewedBy: nurseId, rejectionReason: reason, reviewNotes: notes || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { regenerationTriggered?: boolean };
      if (data.regenerationTriggered) {
        setToast({ message: `Protocol rejected. Revised protocol is now pending review for Patient ${review.patientId}`, type: "success" });
      } else {
        setToast({ message: `Protocol rejected. Regeneration failed — manual review required for Patient ${review.patientId}`, type: "warning" });
      }
      setSelectedReview(null);
      await fetchReviews();
    } catch (err) {
      console.error("Reject failed:", err);
      setToast({ message: "Failed to reject protocol", type: "error" });
    }
  };

  const handleQuickApprove = (review: ProtocolReviewRecord) => {
    void handleApprove(review, "");
  };

  return (
    <div className="min-h-screen bg-slate-900">
      {/* ── Toast ── */}
      {toast && <Toast message={toast.message} type={toast.type} />}

      {/* ── Header ── */}
      <header className="sticky top-0 z-40 bg-slate-900/95 backdrop-blur border-b border-slate-700 px-4 py-3">
        <div className="max-w-7xl mx-auto flex items-center gap-4 flex-wrap">
          {/* Left: branding */}
          <div className="flex-shrink-0">
            <div className="font-bold text-lg text-white tracking-wide">SENTINEL VOICE</div>
            <div className="text-xs text-slate-400">Post-Discharge Triage Dashboard</div>
          </div>

          {/* Centre: triage stat pills + pending review count */}
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
            <span className="text-slate-600 font-light">|</span>
            <button
              onClick={() => setActiveTab("protocols")}
              className={`flex items-center gap-1 px-3 py-1 rounded-full border text-sm font-semibold transition-colors ${
                (pendingProtocolCount ?? reviewStats.pending) > 0
                  ? "bg-amber-900 border-amber-600 text-amber-200 hover:bg-amber-800"
                  : "bg-slate-800 border-slate-600 text-slate-400 hover:bg-slate-700"
              }`}
            >
              📋 {pendingProtocolCount ?? reviewStats.pending} PENDING REVIEW
            </button>
          </div>

          {/* Right: refresh info + nurse ID */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="text-right">
              <div className="text-xs text-slate-400">
                Last updated:{" "}
                {mounted ? formatTime(lastRefresh) : "--:--:-- --"}
              </div>
              {refreshing && (
                <div className="text-xs text-blue-400 animate-pulse">Refreshing…</div>
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
        {/* Tab navigation */}
        <div className="flex gap-1 mb-6 border-b border-slate-700">
          <button
            onClick={() => setActiveTab("triage")}
            className={`px-4 py-2 text-sm font-semibold transition-colors relative ${
              activeTab === "triage"
                ? "text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Triage Results
            {activeTab === "triage" && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-white rounded-full" />
            )}
          </button>
          <button
            onClick={() => setActiveTab("protocols")}
            className={`px-4 py-2 text-sm font-semibold transition-colors relative flex items-center gap-2 ${
              activeTab === "protocols"
                ? "text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Protocol Review
            {reviewStats.pending > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-amber-700 text-amber-100 text-xs font-bold">
                {reviewStats.pending}
              </span>
            )}
            {activeTab === "protocols" && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-white rounded-full" />
            )}
          </button>
        </div>

        {/* ── Triage Results tab ── */}
        {activeTab === "triage" && (
          <>
            {loading ? (
              <LoadingSkeleton />
            ) : patients.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="text-5xl mb-4">📋</div>
                <h2 className="text-xl font-semibold text-slate-300">No triage results yet</h2>
                <p className="text-slate-500 mt-2 text-sm">
                  Patient records will appear here once post-discharge calls are completed.
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
          </>
        )}

        {/* ── Protocol Review tab ── */}
        {activeTab === "protocols" && (
          <>
            {/* Review stats bar */}
            <div className="flex items-center gap-4 mb-6 px-4 py-3 bg-slate-800 rounded-lg border border-slate-700">
              <span className="text-sm text-slate-400">
                Pending: <strong className="text-amber-400">{reviewStats.pending}</strong>
              </span>
              <span className="text-slate-600">|</span>
              <span className="text-sm text-slate-400">
                Approved: <strong className="text-green-400">{reviewStats.approved}</strong>
              </span>
              <span className="text-slate-600">|</span>
              <span className="text-sm text-slate-400">
                Rejected: <strong className="text-red-400">{reviewStats.rejected}</strong>
              </span>
              {reviewStats.autoApproved > 0 && (
                <>
                  <span className="text-slate-600">|</span>
                  <span className="text-sm text-slate-400">
                    Auto-approved: <strong className="text-slate-300">{reviewStats.autoApproved}</strong>
                  </span>
                </>
              )}
            </div>

            {reviews.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="text-5xl mb-4">✅</div>
                <h2 className="text-xl font-semibold text-slate-300">No protocol reviews</h2>
                <p className="text-slate-500 mt-2 text-sm">
                  Protocol reviews will appear here when care planner protocols require clinical validation.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {reviews.map((review) => (
                  <ReviewCard
                    key={review.reviewId}
                    review={review}
                    onOpenModal={setSelectedReview}
                    onQuickApprove={handleQuickApprove}
                  />
                ))}
              </div>
            )}
          </>
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

      {/* ── Protocol Review Modal ── */}
      {selectedReview && (
        <ReviewModal
          review={selectedReview}
          nurseId={nurseId}
          onClose={() => setSelectedReview(null)}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}
    </div>
  );
}
