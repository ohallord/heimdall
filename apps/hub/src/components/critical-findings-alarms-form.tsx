"use client";

import { useState } from "react";

export function CriticalFindingsAlarmsForm({
  initialEnabled,
  canEdit,
}: {
  initialEnabled: boolean;
  canEdit: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
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
        body: JSON.stringify({ criticalFindingsToAlarms: enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : JSON.stringify(data.error ?? res.statusText),
        );
      }
      setEnabled(Boolean(data.criticalFindingsToAlarms));
      setMessage(
        data.criticalFindingsToAlarms
          ? "Critical findings will open Alarms."
          : "Critical findings will not open Alarms.",
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
            Critical findings → Alarms
          </h2>
          <p className="mt-1 text-xs text-muted">
            When enabled, newly ingested critical findings open an Alarm with a
            stable fingerprint (mute/dismiss apply).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4 px-4 py-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!canEdit || busy}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Raise Alarms for new critical findings
          </label>
          {canEdit ? (
            <button
              type="submit"
              disabled={busy}
              className="border border-border bg-background px-4 py-2 text-sm font-medium hover:border-signal disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          ) : (
            <p className="text-xs text-muted">Requires operator or admin.</p>
          )}
        </div>
        {message ? <p className="px-4 pb-4 text-sm text-signal">{message}</p> : null}
        {error ? <p className="px-4 pb-4 text-sm text-danger">{error}</p> : null}
      </div>
    </form>
  );
}
