"use client";

import { useState } from "react";

export function BackupPanel() {
  const [busy, setBusy] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function exportBackup() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/v1/admin/backup?includeSecrets=${includeSecrets ? "1" : "0"}`,
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "export failed");
      const text = JSON.stringify(data.backup, null, 2);
      setJson(text);
      setMessage(
        includeSecrets
          ? "Exported with secrets — store offline."
          : "Exported (secrets redacted).",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "export failed");
    } finally {
      setBusy(false);
    }
  }

  async function restoreBackup() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const backup = JSON.parse(json);
      const res = await fetch("/api/v1/admin/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backup }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "restore failed");
      const r = data.restored;
      setMessage(
        `Restored clusters=${r.clusters} channels=${r.channels} rules=${r.rules} remotes=${r.remotes} oidc=${r.oidcProviders}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "restore failed");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `heimdall-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4 border border-border bg-surface p-4">
      <header>
        <h2 className="text-sm font-semibold uppercase tracking-wide">
          Backup / restore
        </h2>
        <p className="mt-1 text-xs text-muted">
          Version-1 JSON of clusters, settings, channels, rules, remotes, and
          OIDC providers. Users are listed for reference only (not restored as
          credentials). Default export redacts tokens and secrets.
        </p>
      </header>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeSecrets}
          onChange={(e) => setIncludeSecrets(e.target.checked)}
        />
        Include secrets in export
      </label>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={exportBackup}
          className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          Export
        </button>
        <button
          type="button"
          disabled={busy || !json}
          onClick={download}
          className="border border-border px-4 py-2 text-sm text-muted hover:border-signal hover:text-signal disabled:opacity-60"
        >
          Download JSON
        </button>
        <button
          type="button"
          disabled={busy || !json}
          onClick={restoreBackup}
          className="border border-border px-4 py-2 text-sm text-muted hover:border-signal hover:text-signal disabled:opacity-60"
        >
          Restore from editor
        </button>
      </div>

      <textarea
        className="h-64 w-full border border-border bg-white p-3 font-mono text-xs"
        value={json}
        onChange={(e) => setJson(e.target.value)}
        placeholder="Paste a Heimdall backup JSON here, or export above."
      />

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {message ? <p className="text-sm text-ok">{message}</p> : null}
    </div>
  );
}
