"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SecurityScanActions() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function syncRemotes() {
    setBusy(true);
    setError(null);
    setMessage(null);
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
      setMessage(
        `Synced ${data.written ?? 0} finding(s)` +
          (data.errors?.length ? ` · ${data.errors.length} warning(s)` : ""),
      );
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
    </div>
  );
}
