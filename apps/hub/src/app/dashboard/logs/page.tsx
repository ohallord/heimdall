import { redirect } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { LogSearchForm } from "@/components/log-search-form";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete } from "@/lib/db/store";
import { searchLogEvents } from "@/lib/logs/ingest";
import { DEFAULT_LOG_RULES } from "@/lib/logs/rules";

export const dynamic = "force-dynamic";

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    rule?: string;
    matchesOnly?: string;
  }>;
}) {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const params = await searchParams;
  const events = session.orgId
    ? await searchLogEvents({
        orgId: session.orgId,
        q: params.q,
        ruleId: params.rule,
        matchesOnly: params.matchesOnly === "1" || !params.q,
        limit: 100,
      })
    : [];

  const matchCount = events.filter((e) => e.matches.length > 0).length;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Logs
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Threat search
        </h1>
        <p className="mt-2 text-sm text-muted">
          Pattern rules for failed SSH, sudo abuse, reverse shells, and crypto
          miners on streamed host/container logs.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-4">
        {DEFAULT_LOG_RULES.map((r) => (
          <div key={r.id} className="border border-border bg-surface px-4 py-4">
            <p className="font-mono text-xs uppercase tracking-wide text-muted">
              {r.category}
            </p>
            <p className="mt-2 text-sm font-semibold">{r.name}</p>
            <p className="mt-1 font-mono text-xs text-muted">{r.severity}</p>
          </div>
        ))}
      </section>

      <LogSearchForm
        initialQ={params.q ?? ""}
        initialRule={params.rule ?? ""}
        initialMatchesOnly={params.matchesOnly === "1" || !params.q}
      />

      <section className="border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Results
          </h2>
          <span className="font-mono text-xs text-muted">
            {events.length} lines · {matchCount} with matches
          </span>
        </div>
        {events.length === 0 ? (
          <EmptyState>
            No log events yet. Point the agent at auth/syslog paths with{" "}
            <code className="mono">HEIMDALL_LOG_PATHS</code> or{" "}
            <code className="mono">heimdall-agent watch-logs</code>.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {events.map((e) => (
              <li key={e.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted">
                  <span>{new Date(e.observed_at).toISOString()}</span>
                  <span>{e.source}</span>
                  {e.severity ? (
                    <span
                      className={
                        e.severity === "critical" || e.severity === "high"
                          ? "text-danger"
                          : "text-warn"
                      }
                    >
                      {e.severity}
                    </span>
                  ) : null}
                  {e.matches.map((m) => (
                    <span key={m.ruleId} className="text-signal">
                      {m.ruleId}
                    </span>
                  ))}
                </div>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-foreground">
                  {e.line}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
