"use client";

import { useMemo, useState } from "react";
import { describeCron, nextCronRuns, validateCron } from "@/lib/security/cron";
import type { SecuritySyncScheduleView } from "@/lib/security/schedule";

function fmt(iso: string | Date | null, tz: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(new Date(iso));
}

const STATUS_CLASS: Record<string, string> = {
  ok: "text-ok",
  warnings: "text-signal",
  error: "text-danger",
  running: "text-muted",
};

export function SecuritySyncSchedulePanel({ initial }: { initial: SecuritySyncScheduleView }) {
  const [view, setView] = useState(initial);
  const [cron, setCron] = useState(initial.cron);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const tz = view.timeZone;
  const invalid = validateCron(cron);
  const preview = useMemo(() => {
    if (invalid) return [];
    try {
      return nextCronRuns(cron, new Date(), tz, 3);
    } catch {
      return [];
    }
  }, [cron, tz, invalid]);
  const dirty = cron.trim().split(/\s+/).join(" ") !== view.cron || enabled !== view.enabled;

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/admin/security-sync-schedule", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cron, enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "save failed");
      setView(data);
      setCron(data.cron);
      setEnabled(data.enabled);
      setMessage("Schedule saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 border border-border bg-surface p-4">
      <header>
        <h2 className="text-sm font-semibold uppercase tracking-wide">
          Scheduled security sync
        </h2>
        <p className="mt-1 text-xs text-muted">
          Runs “Sync GitHub / GitLab remotes” on a crontab schedule (minute hour day month
          weekday). Findings closed upstream are resolved on each run.
        </p>
      </header>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>

      <label className="block text-sm">
        <span className="text-xs uppercase tracking-wide text-muted">Cron expression</span>
        <input
          type="text"
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          spellCheck={false}
          aria-invalid={invalid ? true : undefined}
          className="mt-1 w-full border border-border bg-white px-3 py-2 font-mono text-sm"
        />
      </label>

      <div className="text-sm">
        <p className="text-xs text-muted">
          Time zone: <span className="font-mono">{tz}</span> (set <span className="font-mono">HEIMDALL_TZ</span>{" "}
          on the hub to change it)
        </p>
        {invalid ? (
          <p className="mt-2 text-danger">Invalid: {invalid}</p>
        ) : (
          <div className="mt-2">
            <p>{describeCron(cron)}</p>
            <p className="mt-1 text-xs text-muted">
              {enabled ? "Next runs:" : "Disabled. Would run:"}
            </p>
            <ul className="mt-1 list-disc pl-5 font-mono text-xs">
              {preview.length === 0 ? <li>never (no matching date)</li> : null}
              {preview.map((d) => (
                <li key={d.toISOString()}>{fmt(d, tz)}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !!invalid || !dirty}
          onClick={save}
          className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          Save schedule
        </button>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {message ? <p className="text-sm text-ok">{message}</p> : null}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-border pt-3 text-xs">
        <dt className="text-muted">Next scheduled run</dt>
        <dd className="font-mono">{view.enabled ? fmt(view.nextRunAt, tz) : "disabled"}</dd>
        <dt className="text-muted">Last run</dt>
        <dd className="font-mono">
          {fmt(view.lastRunAt, tz)}
          {view.lastRunStatus ? (
            <span className={`ml-2 ${STATUS_CLASS[view.lastRunStatus] ?? ""}`}>
              {view.lastRunStatus}
              {view.lastRunWritten != null ? `, ${view.lastRunWritten} findings` : ""}
              {view.lastRunDurationMs != null ? `, ${(view.lastRunDurationMs / 1000).toFixed(1)}s` : ""}
            </span>
          ) : null}
        </dd>
      </dl>
      {view.lastRunWarnings.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">
            {view.lastRunWarnings.length} warning{view.lastRunWarnings.length === 1 ? "" : "s"} from the
            last run
          </summary>
          <ul className="mt-1 list-disc pl-5 font-mono">
            {view.lastRunWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
