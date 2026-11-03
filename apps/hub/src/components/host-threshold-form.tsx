"use client";

import { useState } from "react";

export type HostRuleEdit = {
  id: string;
  name: string;
  metric: string;
  warnThreshold: number | null;
  alarmThreshold: number;
};

export function HostThresholdForm({ initial }: { initial: HostRuleEdit[] }) {
  const [rules, setRules] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function updateLocal(
    id: string,
    patch: Partial<Pick<HostRuleEdit, "warnThreshold" | "alarmThreshold">>,
  ) {
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      for (const rule of rules) {
        const res = await fetch(`/api/v1/alerts/rules/${rule.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            warnThreshold: rule.warnThreshold,
            alarmThreshold: rule.alarmThreshold,
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
      }
      setMessage("Host thresholds saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  if (rules.length === 0) {
    return (
      <p className="text-sm text-muted">
        No host utilization rules yet. They are created on first agent metrics
        ingest.
      </p>
    );
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-6">
      <div className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Host status bands
          </h2>
          <p className="mt-1 text-xs text-muted">
            Warn (yellow) is UI/history only by default. Alarm (red) notifies
            channels. Defaults follow Netdata.
          </p>
        </div>
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
            <tr>
              <th className="px-4 py-2">Metric</th>
              <th className="px-4 py-2">Warn %</th>
              <th className="px-4 py-2">Alarm %</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3">
                  <p className="font-medium">{rule.name}</p>
                  <p className="font-mono text-xs text-muted">{rule.metric}</p>
                </td>
                <td className="px-4 py-3">
                  <input
                    type="number"
                    step="1"
                    min={0}
                    max={100}
                    className="w-24 border border-border bg-background px-2 py-1 font-mono text-sm"
                    value={rule.warnThreshold ?? ""}
                    onChange={(e) =>
                      updateLocal(rule.id, {
                        warnThreshold:
                          e.target.value === ""
                            ? null
                            : Number(e.target.value),
                      })
                    }
                  />
                </td>
                <td className="px-4 py-3">
                  <input
                    type="number"
                    step="1"
                    min={0}
                    max={100}
                    required
                    className="w-24 border border-border bg-background px-2 py-1 font-mono text-sm"
                    value={rule.alarmThreshold}
                    onChange={(e) =>
                      updateLocal(rule.id, {
                        alarmThreshold: Number(e.target.value),
                      })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {message ? <p className="text-sm text-ok">{message}</p> : null}

      <button
        type="submit"
        disabled={busy}
        className="self-start border border-signal bg-signal px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save thresholds"}
      </button>
    </form>
  );
}
