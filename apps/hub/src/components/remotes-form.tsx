"use client";

import { useRouter } from "next/navigation";
import { apiErrorMessage } from "@/lib/api-error";
import { useState } from "react";

export type RemoteView = {
  id: string;
  kind: "github" | "gitlab";
  name: string;
  tokenHint: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
};

export function RemotesForm({
  initial,
  canWrite,
}: {
  initial: RemoteView[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [remotes, setRemotes] = useState(initial);
  const [kind, setKind] = useState<"github" | "gitlab">("github");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [org, setOrg] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canWrite) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const payload: Record<string, unknown> = {
        kind,
        name: name || (kind === "github" ? org : projectPath),
        token,
        enabled: true,
      };
      if (kind === "github") payload.org = org || name;
      if (kind === "gitlab") payload.projectPath = projectPath || name;
      if (apiBaseUrl) payload.apiBaseUrl = apiBaseUrl;

      const res = await fetch("/api/v1/security/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(apiErrorMessage(data, "save remote failed"));
      }
      setMessage(`Saved ${data.connection.kind} · ${data.connection.name}`);
      setToken("");
      setName("");
      setOrg("");
      setProjectPath("");
      setApiBaseUrl("");
      const list = await fetch("/api/v1/security/connections");
      const listed = await list.json();
      if (list.ok) setRemotes(listed.connections);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Connected remotes
          </h2>
          <p className="mt-1 text-xs text-muted">
            Add as many GitHub orgs and GitLab projects as you need.
          </p>
        </div>
        {remotes.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">No remotes configured.</p>
        ) : (
          <ul className="divide-y divide-border">
            {remotes.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
              >
                <span>
                  <span className="font-mono text-xs uppercase text-muted">
                    {r.kind}
                  </span>{" "}
                  {r.name}
                  {r.enabled ? "" : " (off)"}
                </span>
                <span className="font-mono text-xs text-muted">
                  {r.tokenHint ?? "****"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canWrite ? (
        <form
          onSubmit={onSubmit}
          className="space-y-3 border border-border bg-surface p-4"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Add remote
          </h2>
          <label className="block text-sm">
            <span className="mb-1 block font-mono text-xs uppercase text-muted">
              Kind
            </span>
            <select
              className="w-full border border-border px-3 py-2 text-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value as "github" | "gitlab")}
            >
              <option value="github">GitHub org</option>
              <option value="gitlab">GitLab project</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-mono text-xs uppercase text-muted">
              Display name
            </span>
            <input
              className="w-full border border-border px-3 py-2 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={kind === "github" ? "acme-corp" : "group/project"}
            />
          </label>
          {kind === "github" ? (
            <label className="block text-sm">
              <span className="mb-1 block font-mono text-xs uppercase text-muted">
                Org slug
              </span>
              <input
                className="w-full border border-border px-3 py-2 font-mono text-sm"
                value={org}
                onChange={(e) => setOrg(e.target.value)}
                required
              />
            </label>
          ) : (
            <label className="block text-sm">
              <span className="mb-1 block font-mono text-xs uppercase text-muted">
                Project path
              </span>
              <input
                className="w-full border border-border px-3 py-2 font-mono text-sm"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                placeholder="group/project"
                required
              />
            </label>
          )}
          <label className="block text-sm">
            <span className="mb-1 block font-mono text-xs uppercase text-muted">
              Token
            </span>
            <input
              className="w-full border border-border px-3 py-2 font-mono text-sm"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-mono text-xs uppercase text-muted">
              API base URL (optional)
            </span>
            <input
              className="w-full border border-border px-3 py-2 font-mono text-sm"
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.target.value)}
              placeholder={
                kind === "github"
                  ? "https://api.github.com"
                  : "https://gitlab.com/api/v4"
              }
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            Save remote
          </button>
        </form>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {message ? <p className="text-sm text-ok">{message}</p> : null}
    </div>
  );
}
