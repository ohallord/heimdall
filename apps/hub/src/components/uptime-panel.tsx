"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiErrorMessage } from "@/lib/api-error";
import type { UptimeCheckView } from "@/lib/uptime/store";

const STATUS_CLASS: Record<string, string> = { up: "text-ok", down: "text-danger" };

const PLACEHOLDER = {
  http: "https://example.com/health",
  tcp: "db.example.com:5432",
  tls: "example.com (port 443) or example.com:8443",
} as const;

export function UptimePanel({ initial, canWrite }: { initial: UptimeCheckView[]; canWrite: boolean }) {
  const router = useRouter();
  const [checks, setChecks] = useState(initial);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"http" | "tcp" | "tls">("http");
  const [target, setTarget] = useState("");
  const [interval, setIntervalSeconds] = useState("60");
  const [expected, setExpected] = useState("");
  const [warnDays, setWarnDays] = useState("14");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(method: string, qs: string, body?: unknown) {
    const res = await fetch(`/api/v1/uptime${qs}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiErrorMessage(data, "request failed"));
    return data as { check?: UptimeCheckView };
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!canWrite) return;
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { name, kind, target, intervalSeconds: Number(interval) };
      if (kind === "http" && expected) payload.expectedStatus = Number(expected);
      if (kind === "tls") payload.tlsWarnDays = Number(warnDays);
      const { check } = await call("POST", "", payload);
      if (check) setChecks((prev) => [...prev, check]);
      setName("");
      setTarget("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "add failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(c: UptimeCheckView) {
    setError(null);
    try {
      const { check } = await call("PATCH", "", { id: c.id, enabled: !c.enabled });
      if (check) setChecks((prev) => prev.map((x) => (x.id === c.id ? check : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "update failed");
    }
  }

  async function remove(c: UptimeCheckView) {
    if (!window.confirm(`Delete the check "${c.name}"?`)) return;
    setError(null);
    try {
      await call("DELETE", `?id=${encodeURIComponent(c.id)}`);
      setChecks((prev) => prev.filter((x) => x.id !== c.id));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  }

  const input = "border border-border bg-background px-2 py-1 text-sm";

  return (
    <div className="flex flex-col gap-6">
      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <div className="overflow-x-auto border border-border bg-surface">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
            <tr>
              <th className="px-4 py-2">Check</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Latency</th>
              <th className="px-4 py-2">Every</th>
              <th className="px-4 py-2">Last run</th>
              {canWrite ? <th className="px-4 py-2" /> : null}
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.id} className="border-b border-border align-top last:border-0">
                <td className="px-4 py-3">
                  <p className="font-medium">{c.name}</p>
                  <p className="font-mono text-xs text-muted">
                    {c.kind} · {c.target}
                  </p>
                </td>
                <td className="px-4 py-3">
                  {!c.enabled ? (
                    <span className="text-muted">paused</span>
                  ) : c.lastStatus ? (
                    <span className={STATUS_CLASS[c.lastStatus]}>{c.lastStatus}</span>
                  ) : (
                    <span className="text-muted">pending</span>
                  )}
                  {c.lastStatus === "down" && c.lastError ? (
                    <p className="max-w-xs break-words font-mono text-xs text-muted">{c.lastError}</p>
                  ) : null}
                </td>
                <td className="px-4 py-3 font-mono text-xs">{c.lastLatencyMs != null ? `${c.lastLatencyMs} ms` : "—"}</td>
                <td className="px-4 py-3 font-mono text-xs">{c.intervalSeconds}s</td>
                <td className="px-4 py-3 font-mono text-xs">{c.lastRunAt ? new Date(c.lastRunAt).toLocaleString() : "—"}</td>
                {canWrite ? (
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <button type="button" onClick={() => void toggle(c)} className="mr-3 text-xs underline">
                      {c.enabled ? "Pause" : "Resume"}
                    </button>
                    <button type="button" onClick={() => void remove(c)} className="text-xs text-danger underline">
                      Delete
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
            {checks.length === 0 ? (
              <tr>
                <td colSpan={canWrite ? 6 : 5} className="px-4 py-6 text-muted">
                  No checks yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {canWrite ? (
        <form onSubmit={add} className="flex flex-col gap-3 border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide">Add a check</h2>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted">
              Name
              <input className={input} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Type
              <select className={input} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="http">HTTP(S)</option>
                <option value="tcp">TCP port</option>
                <option value="tls">TLS certificate</option>
              </select>
            </label>
            <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-xs text-muted">
              Target
              <input
                className={`${input} font-mono`}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={PLACEHOLDER[kind]}
                required
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Every (s)
              <input className={`${input} w-24`} type="number" min={30} max={86400} value={interval} onChange={(e) => setIntervalSeconds(e.target.value)} />
            </label>
            {kind === "http" ? (
              <label className="flex flex-col gap-1 text-xs text-muted">
                Expected status
                <input className={`${input} w-28`} type="number" min={100} max={599} placeholder="any 2xx/3xx" value={expected} onChange={(e) => setExpected(e.target.value)} />
              </label>
            ) : null}
            {kind === "tls" ? (
              <label className="flex flex-col gap-1 text-xs text-muted">
                Warn (days left)
                <input className={`${input} w-24`} type="number" min={1} max={365} value={warnDays} onChange={(e) => setWarnDays(e.target.value)} />
              </label>
            ) : null}
          </div>
          <button
            type="submit"
            disabled={busy}
            className="self-start border border-signal bg-signal px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add check"}
          </button>
          <p className="text-xs text-muted">
            Private and loopback targets are refused unless allowed with HEIMDALL_ALLOW_PRIVATE_HOSTS on the hub.
          </p>
        </form>
      ) : (
        <p className="text-sm text-muted">Adding checks requires operator or admin role.</p>
      )}
    </div>
  );
}
