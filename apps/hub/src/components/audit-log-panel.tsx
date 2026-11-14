"use client";

import { useEffect, useState } from "react";

type Entry = {
  id: string;
  actorEmail: string | null;
  actorUserId: string | null;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
};

const ACTIONS = [
  "security.sync_schedule.update",
  "org.settings.update",
  "alert.rule.update",
  "agent_token.create",
  "agent_token.revoke",
  "agent_token.replace",
  "bootstrap_token.rotate",
  "bootstrap_token.disable",
  "bootstrap_token.revert",
  "oidc.provider.save",
  "backup.export",
  "backup.restore",
  "security.connection.add",
  "alert_channel.save",
  "uptime.check.create",
  "uptime.check.update",
  "uptime.check.delete",
];

export function AuditLogPanel() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchPage(forAction: string, after: string | null) {
    const qs = new URLSearchParams({ limit: "25" });
    if (forAction) qs.set("action", forAction);
    if (after) qs.set("cursor", after);
    const res = await fetch(`/api/v1/admin/audit?${qs}`);
    const json = (await res.json().catch(() => ({}))) as {
      entries?: Entry[];
      nextCursor?: string | null;
      error?: string;
    };
    if (!res.ok) throw new Error(json.error ?? "could not load audit log");
    return { entries: json.entries ?? [], nextCursor: json.nextCursor ?? null };
  }

  async function load(forAction: string, after: string | null, replace: boolean) {
    setBusy(true);
    setError(null);
    try {
      const page = await fetchPage(forAction, after);
      setEntries((prev) => (replace ? page.entries : [...prev, ...page.entries]));
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load audit log");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetchPage("", null)
      .then((page) => {
        if (cancelled) return;
        setEntries(page.entries);
        setCursor(page.nextCursor);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "could not load audit log");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Audit log</h2>
          <p className="text-sm text-muted">Who changed settings, tokens, rules and backups. Kept for the logs retention window.</p>
        </div>
        <label className="text-sm">
          <span className="sr-only">Filter by action</span>
          <select
            className="rounded border border-border bg-bg px-2 py-1 text-sm"
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              void load(e.target.value, null, true);
            }}
          >
            <option value="">All actions</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </header>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-1 pr-3">When</th>
              <th className="py-1 pr-3">Who</th>
              <th className="py-1 pr-3">Action</th>
              <th className="py-1 pr-3">Target</th>
              <th className="py-1">Detail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-border align-top">
                <td className="whitespace-nowrap py-1 pr-3 font-mono text-xs">{new Date(e.createdAt).toLocaleString()}</td>
                <td className="py-1 pr-3">{e.actorEmail ?? e.actorUserId ?? "—"}</td>
                <td className="py-1 pr-3 font-mono text-xs">{e.action}</td>
                <td className="py-1 pr-3 font-mono text-xs">{e.target ?? "—"}</td>
                <td className="py-1 font-mono text-xs text-muted">
                  {Object.keys(e.detail).length ? JSON.stringify(e.detail) : "—"}
                </td>
              </tr>
            ))}
            {!entries.length && !busy ? (
              <tr>
                <td colSpan={5} className="py-3 text-muted">
                  No entries yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {cursor ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void load(action, cursor, false)}
          className="self-start rounded border border-border px-3 py-1 text-sm hover:bg-bg disabled:opacity-50"
        >
          {busy ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </section>
  );
}
