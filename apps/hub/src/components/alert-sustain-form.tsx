"use client";

import { useState } from "react";

const MAX_SECONDS = 3600;

function describe(seconds: number): string {
  if (seconds === 0) return "Alerts open on the first breaching sample.";
  if (seconds < 120) return `A breach must last ${seconds}s before an alert opens.`;
  return `A breach must last ${Math.round((seconds / 60) * 10) / 10} min before an alert opens.`;
}

export function AlertSustainForm({
  initialSeconds,
  canEdit,
}: {
  initialSeconds: number;
  canEdit: boolean;
}) {
  const [saved, setSaved] = useState(initialSeconds);
  const [seconds, setSeconds] = useState(initialSeconds);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const valid = Number.isInteger(seconds) && seconds >= 0 && seconds <= MAX_SECONDS;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || !valid) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/org/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alertSustainSeconds: seconds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : JSON.stringify(data.error ?? res.statusText),
        );
      }
      setSaved(data.alertSustainSeconds);
      setSeconds(data.alertSustainSeconds);
      setMessage(describe(data.alertSustainSeconds));
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
            Alert sustain window
          </h2>
          <p className="mt-1 text-xs text-muted">
            How long a threshold breach must last before an alert opens and notifies. A spike
            that clears sooner is ignored, so alerts stop flapping red then green. 0 alerts
            immediately. Offline agents already wait their own minutes.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-4 px-4 py-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted">Seconds</span>
            <input
              type="number"
              min={0}
              max={MAX_SECONDS}
              step={1}
              value={Number.isNaN(seconds) ? "" : seconds}
              disabled={!canEdit || busy}
              onChange={(e) => setSeconds(e.target.value === "" ? NaN : Number(e.target.value))}
              className="w-28 border border-border bg-background px-3 py-2 font-mono text-sm disabled:opacity-50"
            />
          </label>
          <p className="pb-2 text-xs text-muted">{valid ? describe(seconds) : `Enter 0–${MAX_SECONDS}.`}</p>
          {canEdit ? (
            <button
              type="submit"
              disabled={busy || !valid || seconds === saved}
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
