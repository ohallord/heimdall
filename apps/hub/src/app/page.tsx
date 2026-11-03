import Link from "next/link";
import { listAgents } from "@/lib/agents";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete } from "@/lib/db/store";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const setupComplete = await isSetupComplete();
  const session = await getSession();
  const agents =
    session.isLoggedIn && session.orgId
      ? await listAgents(session.orgId)
      : [];
  const showRegistry = Boolean(session.isLoggedIn && session.orgId);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Self-hosted monitoring
        </p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight text-foreground">
          Heimdall
        </h1>
        <p className="mt-3 max-w-2xl text-base text-muted">
          Self-hosted monitoring hub with first-run setup, RBAC, MFA, and alert
          channel plumbing.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          {!setupComplete ? (
            <Link
              href="/setup"
              className="bg-signal px-4 py-2 text-sm font-medium text-white"
            >
              Start setup wizard
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="bg-signal px-4 py-2 text-sm font-medium text-white"
              >
                Sign in
              </Link>
              <Link
                href="/dashboard"
                className="border border-border px-4 py-2 text-sm text-foreground"
              >
                Dashboard
              </Link>
            </>
          )}
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <StatusTile
          label="Setup"
          value={setupComplete ? "complete" : "required"}
          tone={setupComplete ? "ok" : "warn"}
        />
        <StatusTile
          label="Registered agents"
          value={showRegistry ? String(agents.length) : "—"}
          tone="signal"
        />
        <StatusTile label="Handshake" value="v0" tone="muted" />
      </section>

      <section className="border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Agent registry
          </h2>
          <span className="font-mono text-xs text-muted">
            {showRegistry ? "session · agents:read" : "sign in required"}
          </span>
        </div>
        {!showRegistry ? (
          <p className="px-4 py-8 text-sm text-muted">
            Sign in to view registered agents for your org. Fleet inventory is
            no longer public.
          </p>
        ) : agents.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted">
            No agents yet. Complete setup or register with a bootstrap / agent
            token.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Hostname</th>
                <th className="px-4 py-2 font-medium">Agent ID</th>
                <th className="px-4 py-2 font-medium">Version</th>
                <th className="px-4 py-2 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-medium">{agent.hostname}</td>
                  <td className="px-4 py-3 font-mono text-xs">{agent.id}</td>
                  <td className="px-4 py-3 font-mono text-xs">{agent.version}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">
                    {agent.lastSeenAt}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function StatusTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "signal" | "muted" | "warn";
}) {
  const toneClass =
    tone === "ok"
      ? "text-ok"
      : tone === "signal"
        ? "text-signal"
        : tone === "warn"
          ? "text-warn"
          : "text-muted";

  return (
    <div className="border border-border bg-surface px-4 py-4">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            tone === "ok"
              ? "bg-ok"
              : tone === "signal"
                ? "bg-signal"
                : tone === "warn"
                  ? "bg-warn"
                  : "bg-border"
          }`}
          aria-hidden
        />
        <p className="font-mono text-xs uppercase tracking-wide text-muted">
          {label}
        </p>
      </div>
      <p className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}
