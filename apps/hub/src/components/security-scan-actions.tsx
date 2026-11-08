"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { syncSummary } from "@/lib/security/sync-summary";

export function SecurityScanActions() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function syncRemotes() {
    setBusy(true);
    setError(null);
    setMessage(null);
    setWarnings([]);
    try {
      const res = await fetch("/api/v1/security/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ syncRemotes: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : JSON.stringify(data.error ?? res.statusText),
        );
      }
      const summary = syncSummary(data);
      setMessage(summary.message);
      setWarnings(summary.warnings);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "sync failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        onClick={syncRemotes}
        className="border border-border px-3 py-2 text-sm text-muted hover:border-signal hover:text-signal disabled:opacity-60"
      >
        Sync GitHub / GitLab remotes
      </button>
      <p className="font-mono text-xs text-muted">
        Trivy/OSV: POST JSON reports to /api/v1/security/scan
      </p>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {message ? <p className="text-sm text-ok">{message}</p> : null}
      {warnings.length ? (
        <ul className="space-y-1 font-mono text-xs text-warn">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
