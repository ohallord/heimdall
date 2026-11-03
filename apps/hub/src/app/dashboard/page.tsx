import Link from "next/link";
import { redirect } from "next/navigation";
import { ContainersTable } from "@/components/containers-table";
import { EmptyState } from "@/components/empty-state";
import { K8sPodsTable } from "@/components/k8s-pods-table";
import { BootstrapWarning } from "@/components/bootstrap-warning";
import { getSession } from "@/lib/auth/session";
import { listAgents } from "@/lib/agents";
import { AgentActions } from "@/components/agent-actions";
import { can } from "@/lib/rbac/permissions";
import {
  getPrimaryOrg,
  isSetupComplete,
  listAlertChannels,
  listAlertEvents,
  listAlertRules,
} from "@/lib/db/store";
import {
  getActiveClusterK8s,
  isAgentOnline,
  listLatestContainers,
  listLatestMetrics,
} from "@/lib/metrics/ingest";
import {
  countK8sProblems,
  isK8sCollectionEnabled,
  k8sApiDisplay,
} from "@/lib/metrics/k8s-status";
import { bandDotClass } from "@/lib/alerts/bands";
import { bandForHostMetric, findHostRule } from "@/lib/alerts/host-thresholds";
import type { ContainerMetric, MountMetric } from "@/lib/db/types";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ k8s?: string }>;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!(await isSetupComplete())) {
    redirect("/setup");
  }

  const session = await getSession();
  if (!session.isLoggedIn) {
    redirect("/login");
  }
  if (session.role === "admin" && !session.mfaVerified) {
    redirect("/login");
  }

  const params = await searchParams;
  const k8sProblemsOnly = params.k8s === "problems";

  const org = await getPrimaryOrg();
  const agents = await listAgents(session.orgId);
  const canManageAgents = Boolean(session.role && can(session.role, "agents:write"));
  const channels = session.orgId ? await listAlertChannels(session.orgId) : [];
  const rules = session.orgId ? await listAlertRules(session.orgId) : [];
  const openAlarms = session.orgId
    ? await listAlertEvents(session.orgId, {
        limit: 200,
        status: "open_queue",
      })
    : [];
  const cpuRule = findHostRule(rules, "cpu_percent");
  const memRule = findHostRule(rules, "mem_percent");
  const diskRule = findHostRule(rules, "disk_percent");
  const latest = session.orgId ? await listLatestMetrics(session.orgId) : [];
  const latestByAgent = new Map(latest.map((row) => [row.agent_id, row]));
  const containerRows = session.orgId
    ? await listLatestContainers(session.orgId)
    : [];
  const containersByAgent = new Map(
    containerRows.map((row) => [row.agent_id, row]),
  );
  const allContainers: Array<
    ContainerMetric & { agentId: string; hostname: string }
  > = [];
  for (const agent of agents) {
    const row = containersByAgent.get(agent.id);
    if (!row) continue;
    const items = JSON.parse(row.containers_json) as ContainerMetric[];
    for (const c of items) {
      allContainers.push({ ...c, agentId: agent.id, hostname: agent.hostname });
    }
  }

  const onlineCount = agents.filter((a) => isAgentOnline(a.lastSeenAt)).length;
  const problemContainers = allContainers.filter(
    (c) =>
      c.oomKilled ||
      c.restartLoop ||
      c.state === "exited" ||
      c.state === "dead",
  );
  const activeK8s = session.orgId
    ? await getActiveClusterK8s(session.orgId)
    : null;
  const k8sEnabled = isK8sCollectionEnabled(activeK8s?.summary);
  const k8sProblems = countK8sProblems(activeK8s?.summary);

  type HostProblem = {
    agentId: string;
    hostname: string;
    reasons: string[];
  };
  const hostProblems: HostProblem[] = [];
  for (const agent of agents) {
    const metrics = latestByAgent.get(agent.id);
    const online = isAgentOnline(agent.lastSeenAt);
    const mounts = metrics
      ? (JSON.parse(metrics.mounts_json) as MountMetric[])
      : [];
    const reasons: string[] = [];
    if (!online) reasons.push("offline");
    const cpuBand = bandForHostMetric(
      metrics ? Number(metrics.cpu_percent) : null,
      cpuRule,
      85,
      95,
    );
    const memBand = bandForHostMetric(
      metrics ? Number(metrics.mem_percent) : null,
      memRule,
      90,
      98,
    );
    if (cpuBand === "red") reasons.push("cpu");
    if (memBand === "red") reasons.push("memory");
    for (const m of mounts) {
      if (!m.present) {
        reasons.push(`mount ${m.path ?? "?"} missing`);
        continue;
      }
      const b = bandForHostMetric(m.usedPercent, diskRule, 90, 98);
      if (b === "red") reasons.push(`mount ${m.path ?? "?"} full`);
    }
    if (reasons.length > 0) {
      hostProblems.push({
        agentId: agent.id,
        hostname: agent.hostname,
        reasons,
      });
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          {org?.name ?? "Heimdall"}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Fleet</h1>
        <p className="mt-2 text-sm text-muted">
          Problems first — open alarms, host red bands, and Kubernetes health.
          {activeK8s ? ` · cluster ${activeK8s.clusterId}` : ""}
        </p>
      </header>

      <BootstrapWarning role={session.role} />

      <section className="border border-border bg-surface" id="problems">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Problems
          </h2>
        </div>
        <ul className="divide-y divide-border text-sm">
          <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <span>
              Open alarms{" "}
              <span
                className={
                  openAlarms.length > 0
                    ? "font-semibold text-warn"
                    : "text-muted"
                }
              >
                {openAlarms.length}
              </span>
            </span>
            <Link
              href="/dashboard/alerts?status=open"
              className="font-mono text-xs text-signal underline"
            >
              Open queue →
            </Link>
          </li>
          <li className="px-4 py-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span>
                Hosts needing attention{" "}
                <span
                  className={
                    hostProblems.length > 0
                      ? "font-semibold text-warn"
                      : "text-muted"
                  }
                >
                  {hostProblems.length}
                </span>
              </span>
              <Link
                href="#servers"
                className="font-mono text-xs text-signal underline"
              >
                Servers →
              </Link>
            </div>
            {hostProblems.length === 0 ? (
              <p className="text-xs text-muted">No red bands or offline hosts.</p>
            ) : (
              <ul className="space-y-1 font-mono text-xs">
                {hostProblems.slice(0, 8).map((h) => (
                  <li key={h.agentId}>
                    <Link
                      href={`/dashboard/hosts/${h.agentId}`}
                      className="text-signal underline"
                    >
                      {h.hostname}
                    </Link>
                    <span className="text-muted"> · {h.reasons.join(", ")}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
          <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <span>
              Kubernetes problems{" "}
              <span
                className={
                  k8sEnabled && k8sProblems > 0
                    ? "font-semibold text-warn"
                    : "text-muted"
                }
              >
                {k8sEnabled ? k8sProblems : activeK8s ? "off" : "—"}
              </span>
            </span>
            <Link
              href={
                k8sEnabled && k8sProblems > 0
                  ? "/dashboard?k8s=problems#kubernetes"
                  : "#kubernetes"
              }
              className="font-mono text-xs text-signal underline"
            >
              Kubernetes →
            </Link>
          </li>
          <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <span>
              Container problems{" "}
              <span
                className={
                  problemContainers.length > 0
                    ? "font-semibold text-warn"
                    : "text-muted"
                }
              >
                {problemContainers.length}
              </span>
            </span>
            <Link
              href="/dashboard/containers"
              className="font-mono text-xs text-signal underline"
            >
              Containers →
            </Link>
          </li>
        </ul>
      </section>

      <section className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Agents" value={String(agents.length)} tone="signal" />
        <Tile label="Online" value={String(onlineCount)} tone="ok" />
        <Tile
          label="Offline"
          value={String(agents.length - onlineCount)}
          tone={agents.length - onlineCount > 0 ? "warn" : "muted"}
          href={agents.length - onlineCount > 0 ? "#servers" : undefined}
        />
        <Tile
          label="Containers"
          value={String(allContainers.length)}
          tone="signal"
          href="/dashboard/containers"
        />
        <Tile
          label="Ctr problems"
          value={String(problemContainers.length)}
          tone={problemContainers.length > 0 ? "warn" : "muted"}
          href="/dashboard/containers"
        />
        <Tile
          label="K8s problems"
          value={k8sEnabled ? String(k8sProblems) : activeK8s ? "off" : "—"}
          tone={!k8sEnabled ? "muted" : k8sProblems > 0 ? "warn" : "ok"}
          href={
            k8sEnabled && k8sProblems > 0
              ? "/dashboard?k8s=problems#kubernetes"
              : "#kubernetes"
          }
        />
      </section>

      <section className="border border-border bg-surface" id="servers">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Servers
          </h2>
          {canManageAgents ? (
            <Link
              href="/dashboard/settings#agents"
              className="font-mono text-xs uppercase tracking-wide text-signal hover:underline"
            >
              + Add a server
            </Link>
          ) : null}
        </div>
        {agents.length === 0 ? (
          <EmptyState>
            No agents registered yet. Go to{" "}
            <Link href="/dashboard/settings#agents" className="text-signal underline">
              Settings → Agents
            </Link>{" "}
            and use “Add a server” for a one-line install command.
          </EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Host</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">CPU</th>
                <th className="px-4 py-2 font-medium">Mem</th>
                <th className="px-4 py-2 font-medium">Mounts</th>
                <th className="px-4 py-2 font-medium">Last seen</th>
                {canManageAgents ? (
                  <th className="px-4 py-2 font-medium">Credentials</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const metrics = latestByAgent.get(agent.id);
                const online = isAgentOnline(agent.lastSeenAt);
                const mounts = metrics
                  ? (JSON.parse(metrics.mounts_json) as MountMetric[])
                  : [];
                const missing = mounts.filter((m) => !m.present).length;
                const cpuBand = bandForHostMetric(
                  metrics ? Number(metrics.cpu_percent) : null,
                  cpuRule,
                  85,
                  95,
                );
                const memBand = bandForHostMetric(
                  metrics ? Number(metrics.mem_percent) : null,
                  memRule,
                  90,
                  98,
                );
                const worstMountBand = mounts.reduce<
                  "green" | "yellow" | "red"
                >((worst, m) => {
                  if (!m.present) return "red";
                  const b = bandForHostMetric(
                    m.usedPercent,
                    diskRule,
                    90,
                    98,
                  );
                  if (b === "red" || worst === "red") return "red";
                  if (b === "yellow" || worst === "yellow") return "yellow";
                  return "green";
                }, "green");
                return (
                  <tr
                    key={agent.id}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/hosts/${agent.id}`}
                        className="font-medium text-signal underline"
                      >
                        {agent.hostname}
                      </Link>
                      {agent.revokedAt ? (
                        <span className="ml-2 border border-danger px-1 text-xs text-danger">
                          revoked
                        </span>
                      ) : agent.legacy ? (
                        <span
                          className="ml-2 border border-border px-1 text-xs text-warn"
                          title="Uses a shared token. Update the agent so it registers and receives a per-agent secret."
                        >
                          legacy token
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        <span
                          className={`h-2 w-2 rounded-full ${online ? "bg-ok" : "bg-danger"}`}
                        />
                        <span className={online ? "text-ok" : "text-danger"}>
                          {online ? "online" : "offline"}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      <span className="inline-flex items-center gap-2">
                        {metrics ? (
                          <span
                            className={`h-2 w-2 rounded-full ${bandDotClass(cpuBand)}`}
                            aria-hidden
                          />
                        ) : null}
                        {metrics
                          ? Number(metrics.cpu_percent).toFixed(1)
                          : "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      <span className="inline-flex items-center gap-2">
                        {metrics ? (
                          <span
                            className={`h-2 w-2 rounded-full ${bandDotClass(memBand)}`}
                            aria-hidden
                          />
                        ) : null}
                        {metrics
                          ? Number(metrics.mem_percent).toFixed(1)
                          : "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      <span className="inline-flex items-center gap-2">
                        {mounts.length > 0 ? (
                          <span
                            className={`h-2 w-2 rounded-full ${bandDotClass(worstMountBand)}`}
                            aria-hidden
                          />
                        ) : null}
                        {mounts.length === 0
                          ? "—"
                          : missing > 0
                            ? `${missing} down`
                            : `${mounts.length} ok`}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">
                      {agent.lastSeenAt}
                    </td>
                    {canManageAgents ? (
                      <td className="px-4 py-3">
                        <AgentActions
                          agentId={agent.id}
                          hostname={agent.hostname}
                          revoked={Boolean(agent.revokedAt)}
                        />
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="border border-border bg-surface" id="kubernetes">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Kubernetes
          </h2>
          <span className="font-mono text-xs text-muted">
            {activeK8s
              ? k8sEnabled
                ? `cluster ${activeK8s.clusterId} · one active`
                : `cluster ${activeK8s.clusterId} · Disabled`
              : "no sample yet"}
            {k8sProblemsOnly ? " · problems only" : ""}
            {" · "}
            <Link href="/dashboard/clusters" className="text-signal underline">
              Clusters
            </Link>
            {k8sProblemsOnly ? (
              <>
                {" · "}
                <Link href="#kubernetes" className="text-signal underline">
                  Show all
                </Link>
              </>
            ) : null}
          </span>
        </div>
        {!activeK8s ? (
          <EmptyState>
            No Kubernetes samples yet. Deploy the in-cluster agent via Helm
            (ServiceAccount + cluster read RBAC) with{" "}
            <code className="mono">HEIMDALL_ENABLE_K8S=true</code>.
          </EmptyState>
        ) : !k8sEnabled ? (
          <EmptyState>
            Kubernetes collection is{" "}
            <strong className="font-medium text-foreground">Disabled</strong> on
            the reporting agent (Compose / bare hosts). This is not an API
            outage — enable with{" "}
            <code className="mono">HEIMDALL_ENABLE_K8S=true</code> on an
            in-cluster agent.
          </EmptyState>
        ) : (
          <div className="grid gap-0 sm:grid-cols-2 lg:grid-cols-4">
            <K8sStat
              label="API server"
              value={
                k8sApiDisplay(activeK8s.summary) === "reachable"
                  ? `${Number(activeK8s.summary.apiServerLatencyMs ?? 0).toFixed(0)} ms`
                  : "down"
              }
              warn={k8sApiDisplay(activeK8s.summary) === "down"}
            />
            <K8sStat
              label="Nodes Ready"
              value={`${activeK8s.summary.nodesReady}/${activeK8s.summary.nodesTotal}`}
              warn={activeK8s.summary.nodesReady < activeK8s.summary.nodesTotal}
            />
            <K8sStat
              label="Pods Pending / CrashLoop"
              value={`${activeK8s.summary.podsPending} / ${activeK8s.summary.podsCrashLoop}`}
              warn={
                activeK8s.summary.podsPending > 0 ||
                activeK8s.summary.podsCrashLoop > 0
              }
            />
            <K8sStat
              label="Deployments unhealthy"
              value={`${activeK8s.summary.deploymentsUnhealthy}/${activeK8s.summary.deploymentsTotal}`}
              warn={activeK8s.summary.deploymentsUnhealthy > 0}
            />
            <div className="border-t border-border sm:col-span-2 lg:col-span-4">
              <div className="flex items-center justify-between border-b border-border px-4 py-2">
                <p className="font-mono text-xs uppercase tracking-wide text-muted">
                  Pods
                </p>
                <span className="font-mono text-xs text-muted">
                  {(activeK8s.summary.pods?.length ?? 0) > 0
                    ? `${activeK8s.summary.pods!.length}${
                        (activeK8s.summary.podsTotal ?? 0) >
                        (activeK8s.summary.pods?.length ?? 0)
                          ? ` of ${activeK8s.summary.podsTotal}`
                          : ""
                      }`
                    : activeK8s.summary.podsTotal != null
                      ? `${activeK8s.summary.podsTotal} total`
                      : "upgrade agent for list"}
                </span>
              </div>
              <K8sPodsTable
                pods={activeK8s.summary.pods ?? []}
                agentId={activeK8s.row.agent_id}
                problemsOnly={k8sProblemsOnly}
                emptyMessage={
                  k8sProblemsOnly
                    ? "No problem pods in the latest sample."
                    : (activeK8s.summary.podProblems?.length ?? 0) > 0
                      ? "No full pod list yet (older agent). Problem pods below."
                      : "No pods in the latest sample (or agent image predates pod list)."
                }
              />
              {(activeK8s.summary.podProblems?.length ?? 0) > 0 &&
                (activeK8s.summary.pods?.length ?? 0) === 0 && (
                  <div className="border-t border-border px-4 py-3">
                    <p className="mb-2 font-mono text-xs uppercase tracking-wide text-muted">
                      Pod problems
                    </p>
                    <ul className="space-y-1 font-mono text-xs">
                      {activeK8s.summary.podProblems!.slice(0, 8).map((p) => (
                        <li key={`${p.namespace}/${p.name}`}>
                          <span className="text-warn">{p.problem}</span>{" "}
                          {p.namespace}/{p.name}
                          {p.reason ? ` · ${p.reason}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
            </div>
          </div>
        )}
      </section>

      <section className="border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Containers
          </h2>
          <Link
            href="/dashboard/containers"
            className="font-mono text-xs text-signal underline"
          >
            Full page
          </Link>
        </div>
        <ContainersTable
          containers={allContainers}
          showHost
          emptyMessage="No container samples yet. Mount the Docker/Podman socket into the agent to enable container collection."
        />
      </section>

      <section className="border border-border bg-surface p-4 text-sm text-muted">
        <p>
          Channels:{" "}
          {channels.map((c) => `${c.kind}${c.enabled ? "" : " (off)"}`).join(", ") ||
            "none"}{" "}
          · rules {rules.length}
        </p>
      </section>
    </main>
  );
}

function Tile({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: string;
  tone: "ok" | "signal" | "muted" | "warn";
  href?: string;
}) {
  const toneClass =
    tone === "ok"
      ? "text-ok"
      : tone === "signal"
        ? "text-signal"
        : tone === "warn"
          ? "text-warn"
          : "text-muted";
  const inner = (
    <>
      <p className="font-mono text-xs uppercase tracking-wide text-muted">
        {label}
      </p>
      <p className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</p>
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        className="border border-border bg-surface px-4 py-4 hover:border-signal"
      >
        {inner}
      </Link>
    );
  }
  return <div className="border border-border bg-surface px-4 py-4">{inner}</div>;
}

function K8sStat({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="border-b border-border px-4 py-4 last:border-b-0 sm:border-r sm:last:border-r-0 lg:border-b-0">
      <p className="font-mono text-xs uppercase tracking-wide text-muted">
        {label}
      </p>
      <p
        className={`mt-2 text-lg font-semibold ${warn ? "text-warn" : "text-foreground"}`}
      >
        {value}
      </p>
    </div>
  );
}
