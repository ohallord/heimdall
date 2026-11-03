import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { MetricHistoryChart } from "@/components/metric-history-chart";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete } from "@/lib/db/store";
import { queryMetricHistory, type HistoryMetric } from "@/lib/metrics/history";
import { getMetricsRetentionDays } from "@/lib/metrics/retention";
import { getAgentById } from "@/lib/metrics/ingest";

export async function MetricHistoryPageShell(input: {
  agentId: string;
  metric: HistoryMetric;
  mount?: string;
  title: string;
}) {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const agent = await getAgentById(input.agentId);
  if (!agent || (session.orgId && agent.org_id !== session.orgId)) {
    notFound();
  }

  const retentionDays = session.orgId
    ? await getMetricsRetentionDays(session.orgId)
    : 30;
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  const initial = session.orgId
    ? await queryMetricHistory({
        orgId: session.orgId,
        agentId: agent.id,
        metric: input.metric,
        from,
        to,
        mount: input.mount,
      })
    : null;
  const initialPoints =
    initial && !("error" in initial) ? initial.points : [];

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Servers · history
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {agent.hostname} · {input.title}
        </h1>
        <p className="mt-3 text-sm">
          <Link
            href={`/dashboard/hosts/${agent.id}`}
            className="text-signal underline"
          >
            ← Server detail
          </Link>
        </p>
      </header>

      <MetricHistoryChart
        agentId={agent.id}
        metric={input.metric}
        mount={input.mount}
        title={input.title}
        retentionDays={retentionDays}
        initialPoints={initialPoints}
      />
    </main>
  );
}
