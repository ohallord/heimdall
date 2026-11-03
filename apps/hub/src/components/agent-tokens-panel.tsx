"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type EnrollmentTokenView = {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
  revokedAt: string | null;
};

export type BootstrapView = {
  mode: "env" | "rotated" | "disabled";
  source: "env" | "database" | "none";
  active: boolean;
  weak: boolean;
  hint: string | null;
  updatedAt: string | null;
  canManage: boolean;
};

type Minted = {
  label: string;
  token: string;
  commands: Array<{ label: string; text: string }>;
};

const EXPIRY_OPTIONS = [
  { label: "1 hour", hours: 1 },
  { label: "24 hours", hours: 24 },
  { label: "7 days", hours: 168 },
  { label: "Never", hours: 0 },
] as const;

function defaultName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `server-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function tokenState(t: EnrollmentTokenView, now = Date.now()): string {
  if (t.revokedAt) return "revoked";
  if (t.expiresAt && Date.parse(t.expiresAt) <= now) return "expired";
  if (t.maxUses != null && t.useCount >= t.maxUses) return "used up";
  return "active";
}

async function call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `request failed (${res.status})`);
  }
  return data;
}

function CopyLine({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted">{label}</p>
      <div className="flex items-start gap-2">
        <code className="flex-1 break-all border border-border bg-[#f8fafb] px-3 py-2 font-mono text-xs">
          {text}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="shrink-0 border border-border px-2 py-2 font-mono text-xs uppercase hover:border-signal"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export function AgentTokensPanel({
  tokens,
  bootstrap,
  canWrite,
}: {
  tokens: EnrollmentTokenView[];
  bootstrap: BootstrapView;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [expiryHours, setExpiryHours] = useState<number>(24);
  const [maxUses, setMaxUses] = useState<string>("1");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<Minted | null>(null);
  const [showAll, setShowAll] = useState(false);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(null);
    }
  }

  function showEnrollment(data: Record<string, unknown>, label: string) {
    const cmds = data.installCommands as {
      agent: string;
      agentWithOtel: string;
      agentNonInteractive: string;
    };
    setMinted({
      label,
      token: String(data.token),
      commands: [
        { label: "Install the agent on the new server (paste the token when prompted)", text: cmds.agent },
        { label: "Agent + OTel collector (prompts for both tokens)", text: cmds.agentWithOtel },
        {
          label: "Non-interactive (token ends up in sudo's system log)",
          text: cmds.agentNonInteractive,
        },
      ],
    });
  }

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    const uses = maxUses === "" ? undefined : Number(maxUses);
    void run("create", async () => {
      const data = await call("/api/v1/agents/tokens", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim() || defaultName(),
          ...(expiryHours > 0 ? { ttlHours: expiryHours } : {}),
          ...(uses ? { maxUses: uses } : {}),
        }),
      });
      showEnrollment(data, `New token "${String(data.name)}"`);
      setShowForm(false);
      setName("");
    });
  };

  const replace = (t: EnrollmentTokenView) =>
    run(`replace:${t.id}`, async () => {
      const data = await call(`/api/v1/agents/tokens/${t.id}/replace`, { method: "POST", body: "{}" });
      showEnrollment(data, `Replacement for "${t.name}" (old token revoked)`);
    });

  const revoke = (t: EnrollmentTokenView) => {
    if (!window.confirm(`Revoke "${t.name}"? Servers already installed keep working.`)) return;
    void run(`revoke:${t.id}`, async () => {
      await call(`/api/v1/agents/tokens/${t.id}`, { method: "DELETE" });
    });
  };

  const bootstrapAction = (action: "rotate" | "disable" | "revert") => {
    const confirmText = {
      rotate:
        "Rotate the bootstrap token? The old value stops working for NEW registrations immediately. Registered agents keep working.",
      disable:
        "Disable the bootstrap token? New servers will need an enrollment token from this page. Registered agents keep working.",
      revert: "Go back to the HEIMDALL_BOOTSTRAP_TOKEN value from the hub's environment?",
    }[action];
    if (!window.confirm(confirmText)) return;
    void run(`bootstrap:${action}`, async () => {
      const data = await call("/api/v1/admin/bootstrap-token", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      if (action === "rotate") {
        setMinted({
          label: "New bootstrap token",
          token: String(data.token),
          commands: [
            {
              label: "Keep the Helm release in sync (in-cluster agent re-registers with it)",
              text: String(data.helmCommand),
            },
            { label: "Docker Compose", text: String(data.composeHint) },
          ],
        });
      }
    });
  };

  const visible = showAll ? tokens : tokens.filter((t) => tokenState(t) === "active");

  return (
    <section id="agents" className="space-y-6 border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide">Agents &amp; tokens</h2>
          <p className="mt-1 text-xs text-muted">
            Add a server with a one-time install command. Tokens only enroll new servers;
            revoking or rotating one never disconnects servers that are already installed.
          </p>
        </div>
        {canWrite ? (
          <button
            type="button"
            onClick={() => {
              setShowForm((v) => !v);
              setMinted(null);
            }}
            className="border border-signal px-4 py-2 font-mono text-xs uppercase tracking-wide text-signal hover:bg-signal hover:text-white"
          >
            {showForm ? "Cancel" : "+ Add a server"}
          </button>
        ) : null}
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {showForm ? (
        <form onSubmit={create} className="flex flex-wrap items-end gap-4 border border-border p-4">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-xs uppercase text-muted">Name</span>
            <input
              value={name}
              placeholder={defaultName()}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              className="w-56 border border-border bg-background px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-xs uppercase text-muted">Expires</span>
            <select
              value={expiryHours}
              onChange={(e) => setExpiryHours(Number(e.target.value))}
              className="border border-border bg-background px-3 py-2 text-sm"
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.label} value={o.hours}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-xs uppercase text-muted">Servers</span>
            <select
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              className="border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="1">1 server</option>
              <option value="5">Up to 5</option>
              <option value="25">Up to 25</option>
              <option value="">Unlimited</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={busy === "create"}
            className="border border-signal bg-signal px-4 py-2 font-mono text-xs uppercase tracking-wide text-white disabled:opacity-50"
          >
            {busy === "create" ? "Creating…" : "Create install command"}
          </button>
        </form>
      ) : null}

      {minted ? (
        <div className="space-y-3 border border-signal p-4">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-semibold">{minted.label}</p>
            <button
              type="button"
              onClick={() => setMinted(null)}
              className="font-mono text-xs uppercase text-muted hover:text-foreground"
            >
              Done
            </button>
          </div>
          <p className="text-xs text-danger">Shown once. Copy it now; Heimdall stores only a hash.</p>
          <CopyLine label="Token" text={minted.token} />
          {minted.commands.map((c) => (
            <CopyLine key={c.label} label={c.label} text={c.text} />
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">Enrollment tokens</h3>
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="font-mono text-xs uppercase text-muted hover:text-foreground"
          >
            {showAll ? "Active only" : `Show all (${tokens.length})`}
          </button>
        </div>
        {visible.length === 0 ? (
          <p className="text-xs text-muted">
            No {showAll ? "" : "active "}enrollment tokens. Use “Add a server” to create one.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border font-mono text-xs uppercase text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Token</th>
                <th className="py-2 pr-3 font-medium">Used</th>
                <th className="py-2 pr-3 font-medium">Expires</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => {
                const state = tokenState(t);
                return (
                  <tr key={t.id} className="border-b border-border last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">{t.name}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-muted">{t.hint}</td>
                    <td className="py-2 pr-3 font-mono text-xs">
                      {t.useCount}
                      {t.maxUses != null ? ` / ${t.maxUses}` : ""}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-muted whitespace-nowrap">
                      {t.expiresAt ? t.expiresAt.replace("T", " ").slice(0, 16) : "never"}
                    </td>
                    <td
                      className={`py-2 pr-3 font-mono text-xs ${
                        state === "active" ? "text-ok" : "text-muted"
                      }`}
                    >
                      {state}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {canWrite ? (
                        <>
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void replace(t)}
                            className="mr-2 font-mono text-xs uppercase text-signal hover:underline disabled:opacity-50"
                          >
                            Replace
                          </button>
                          {state !== "revoked" ? (
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => revoke(t)}
                              className="font-mono text-xs uppercase text-danger hover:underline disabled:opacity-50"
                            >
                              Revoke
                            </button>
                          ) : null}
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">Bootstrap token (hub-wide)</h3>
        <p className="text-xs text-muted">
          A shared token any new server can register with (used by Compose/Helm agents).
          Prefer per-server enrollment tokens above.
        </p>
        <p className="font-mono text-xs">
          {bootstrap.mode === "disabled"
            ? "Disabled: new servers need an enrollment token."
            : bootstrap.mode === "rotated"
              ? `Rotated from this page · ${bootstrap.hint ?? ""}`
              : bootstrap.active
                ? `From HEIMDALL_BOOTSTRAP_TOKEN · ${bootstrap.hint ?? ""}`
                : "Not set (HEIMDALL_BOOTSTRAP_TOKEN is empty)."}
          {bootstrap.updatedAt ? ` · changed ${bootstrap.updatedAt.replace("T", " ").slice(0, 16)}` : ""}
        </p>
        {bootstrap.weak ? (
          <p className="text-xs text-danger">
            This is the well-known development token (or too short). Anyone who knows it can
            register agents. Rotate or disable it.
          </p>
        ) : null}
        {bootstrap.canManage ? (
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => bootstrapAction("rotate")}
              className="border border-signal px-3 py-1.5 font-mono text-xs uppercase text-signal hover:bg-signal hover:text-white disabled:opacity-50"
            >
              Rotate
            </button>
            {bootstrap.mode !== "disabled" ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => bootstrapAction("disable")}
                className="border border-border px-3 py-1.5 font-mono text-xs uppercase hover:border-danger hover:text-danger disabled:opacity-50"
              >
                Disable
              </button>
            ) : null}
            {bootstrap.mode !== "env" ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => bootstrapAction("revert")}
                className="border border-border px-3 py-1.5 font-mono text-xs uppercase hover:border-signal disabled:opacity-50"
              >
                Use env value
              </button>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted">Only an admin of the hub&apos;s primary org can change it.</p>
        )}
      </div>
    </section>
  );
}
