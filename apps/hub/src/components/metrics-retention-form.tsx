"use client";

import { useState } from "react";
import {
  DEFAULT_TRACES_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  MAX_TRACES_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  MIN_TRACES_RETENTION_DAYS,
} from "@/lib/metrics/retention-constants";

export function MetricsRetentionForm({
  initialDays,
  initialTracesDays = DEFAULT_TRACES_RETENTION_DAYS,
  canEdit,
}: {
  initialDays: number;
  initialTracesDays?: number;
  canEdit: boolean;
}) {
  const [days, setDays] = useState(initialDays);
  const [tracesDays, setTracesDays] = useState(initialTracesDays);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/org/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          metricsRetentionDays: days,
          logsRetentionDays: days,
          tracesRetentionDays: tracesDays,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : JSON.stringify(data.error ?? res.statusText),
        );
      }
      setDays(data.metricsRetentionDays ?? days);
      setTracesDays(data.tracesRetentionDays ?? tracesDays);
      setMessage(
        `Retention set to ${data.metricsRetentionDays} days (traces ${data.tracesRetentionDays} days).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <div className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Metric history retention
          </h2>
          <p className="mt-1 text-xs text-muted">
            Keep host samples for {MIN_RETENTION_DAYS}–{MAX_RETENTION_DAYS} days.
            Default 60 days. Older rows are purged on ingest and by a
            scheduled job. Saving applies the same window to metrics, log
            lines and closed alerts (open alarms are never purged). Trace spans
            use their own {MIN_TRACES_RETENTION_DAYS}–{MAX_TRACES_RETENTION_DAYS}
            day window (default {DEFAULT_TRACES_RETENTION_DAYS}).
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-4 px-4 py-4">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-xs uppercase tracking-wide text-muted">
              Days
            </span>
            <input
              type="number"
              min={MIN_RETENTION_DAYS}
              max={MAX_RETENTION_DAYS}
              value={days}
              disabled={!canEdit || busy}
              onChange={(e) => setDays(Number(e.target.value))}
              className="w-28 border border-border bg-background px-3 py-2 font-mono text-sm disabled:opacity-50"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-xs uppercase tracking-wide text-muted">
              Trace days
            </span>
            <input
              type="number"
              min={MIN_TRACES_RETENTION_DAYS}
              max={MAX_TRACES_RETENTION_DAYS}
              value={tracesDays}
              disabled={!canEdit || busy}
              onChange={(e) => setTracesDays(Number(e.target.value))}
              className="w-28 border border-border bg-background px-3 py-2 font-mono text-sm disabled:opacity-50"
            />
          </label>
          {canEdit ? (
            <button
              type="submit"
              disabled={busy}
              className="border border-signal px-4 py-2 text-xs font-mono uppercase tracking-wide text-signal hover:bg-signal hover:text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save retention"}
            </button>
          ) : (
            <p className="text-sm text-muted">
              Retention editing requires operator or admin role.
            </p>
          )}
        </div>
      </div>
      {message ? <p className="text-sm text-ok">{message}</p> : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </form>
  );
}
