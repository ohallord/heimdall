import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { ContainersTable } from "@/components/containers-table";
import { K8sPodsTable } from "@/components/k8s-pods-table";
import { Sparkline } from "@/components/sparkline";
import { bandDotClass, bandTextClass } from "@/lib/alerts/bands";
import { bandForHostMetric, findHostRule } from "@/lib/alerts/host-thresholds";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete, listAlertRules } from "@/lib/db/store";
import {
  getAgentById,
  getLatestContainers,
  getLatestK8s,
  getLatestMetrics,
  isAgentOnline,
  listMetricHistory,
} from "@/lib/metrics/ingest";
import {
  isK8sCollectionEnabled,
  k8sApiLabel,
} from "@/lib/metrics/k8s-status";
import { listFindings } from "@/lib/security/store";
import type {
  ContainerMetric,
  K8sClusterMetric,
  MountMetric,
} from "@/lib/db/types";

export const dynamic = "force-dynamic";

export default async function HostDetailPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const { agentId } = await params;
  const agent = await getAgentById(agentId);
  if (!agent || (session.orgId && agent.org_id !== session.orgId)) {
    notFound();
  }

  const latest = await getLatestMetrics(agent.id);
  const history = await listMetricHistory(agent.id, 48);
  const online = isAgentOnline(agent.last_seen_at);
  const mounts = latest
    ? (JSON.parse(latest.mounts_json) as MountMetric[])
    : [];
  const containerRow = await getLatestContainers(agent.id);
  const containers = containerRow
    ? (JSON.parse(containerRow.containers_json) as ContainerMetric[])
    : [];
  const k8sRow = await getLatestK8s(agent.id);
  const k8s = k8sRow
    ? (JSON.parse(k8sRow.summary_json) as K8sClusterMetric)
    : null;

  const rules = session.orgId ? await listAlertRules(session.orgId) : [];
  const cpuRule = findHostRule(rules, "cpu_percent");
  const memRule = findHostRule(rules, "mem_percent");
  const diskRule = findHostRule(rules, "disk_percent");

  const cpuBand = bandForHostMetric(
    latest ? Number(latest.cpu_percent) : null,
    cpuRule,
    85,
    95,
  );
  const memBand = bandForHostMetric(
    latest ? Number(latest.mem_percent) : null,
    memRule,
    90,
    98,
  );

  const showKubernetes = Boolean(k8s && isK8sCollectionEnabled(k8s));
  const showContainers = containers.length > 0;
  const postureFindings = session.orgId
    ? await listFindings(session.orgId, {
        source: "host_posture",
        agentId: agent.id,
        limit: 100,
      })
    : [];

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Servers · detail
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{agent.hostname}</h1>
          <StatusDot online={online} />
        </div>
        <p className="mt-2 font-mono text-xs text-muted">
          {agent.id} · v{agent.version} · cluster {agent.cluster_id ?? "default"} ·
          last seen {new Date(agent.last_seen_at).toISOString()}
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <MetricCard
          label="CPU %"
          value={fmt(latest?.cpu_percent)}
          band={cpuBand}
          href={`/dashboard/hosts/${agent.id}/cpu`}
        />
        <MetricCard
          label="Memory %"
          value={fmt(latest?.mem_percent)}
          band={memBand}
          href={`/dashboard/hosts/${agent.id}/memory`}
        />
        <MetricCard label="Load 1" value={fmt(latest?.load1)} />
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <ChartCard
          title="CPU"
          href={`/dashboard/hosts/${agent.id}/cpu`}
          values={history.map((h) => Number(h.cpu_percent))}
        />
        <ChartCard
          title="Memory"
          href={`/dashboard/hosts/${agent.id}/memory`}
          values={history.map((h) => Number(h.mem_percent))}
        />
        <ChartCard title="Load 1" values={history.map((h) => Number(h.load1))} />
        <ChartCard
          title="Root disk"
          href={`/dashboard/hosts/${agent.id}/disk?mount=${encodeURIComponent("/")}`}
          values={history.map((h) => rootDiskPercent(h.disks_json) ?? 0)}
        />
      </section>

      <section className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">Mounts</h2>
        </div>
        {mounts.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">No mount samples yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2">Path</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Present</th>
                <th className="px-4 py-2">Used %</th>
                <th className="px-4 py-2">FS</th>
              </tr>
            </thead>
            <tbody>
              {mounts.map((m) => {
                const mountBand = !m.present
                  ? ("red" as const)
                  : bandForHostMetric(m.usedPercent, diskRule, 90, 98);
                const diskHref = `/dashboard/hosts/${agent.id}/disk?mount=${encodeURIComponent(m.path)}`;
                return (
                  <tr key={m.path} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 font-mono text-xs">
                      <Link href={diskHref} className="text-signal underline">
                        {m.path}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        <span
                          className={`h-2 w-2 rounded-full ${bandDotClass(mountBand)}`}
                          aria-hidden
                        />
                        <span className={`font-mono text-xs uppercase ${bandTextClass(mountBand)}`}>
                          {mountBand}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={m.present ? "text-ok" : "text-danger"}>
                        {m.present ? "yes" : "missing"}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      <Link href={diskHref} className="hover:underline">
                        {m.usedPercent != null ? m.usedPercent.toFixed(1) : "—"}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">
                      {m.fsType ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {showKubernetes ? (
        <section className="border border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide">
              Kubernetes
            </h2>
            <span className="font-mono text-xs text-muted">
              {k8sRow ? `cluster ${k8sRow.cluster_id}` : "none"}
            </span>
          </div>
          <>
            <div className="grid gap-4 px-4 py-4 sm:grid-cols-4">
              <MetricCard label="API" value={k8sApiLabel(k8s!)} />
              <MetricCard
                label="Nodes"
                value={`${k8s!.nodesReady}/${k8s!.nodesTotal}`}
              />
              <MetricCard
                label="Pending / Crash"
                value={`${k8s!.podsPending}/${k8s!.podsCrashLoop}`}
              />
              <MetricCard
                label="Unhealthy deps"
                value={String(k8s!.deploymentsUnhealthy)}
              />
            </div>
            <div className="border-t border-border">
              <div className="border-b border-border px-4 py-2">
                <p className="font-mono text-xs uppercase tracking-wide text-muted">
                  Pods
                </p>
              </div>
              <K8sPodsTable
                pods={k8s!.pods ?? []}
                agentId={agent.id}
                emptyMessage="No pod list in this sample (rebuild/redeploy agent for pod rows)."
              />
            </div>
          </>
        </section>
      ) : null}

      {showContainers ? (
        <section className="border border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide">
              Containers
            </h2>
            <span className="font-mono text-xs text-muted">
              runtime {containerRow?.runtime ?? "none"}
              {" · "}
              <Link href="/dashboard/containers" className="text-signal underline">
                Fleet containers
              </Link>
            </span>
          </div>
          <ContainersTable containers={containers} />
        </section>
      ) : null}

      <section className="border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Security / Posture
          </h2>
          <span className="font-mono text-xs text-muted">
            {postureFindings.length} open
            {" · "}
            <Link
              href="/dashboard/security?source=host_posture"
              className="text-signal underline"
            >
              All host posture
            </Link>
          </span>
        </div>
        {postureFindings.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">
            No host posture findings yet. Install Trivy beside the agent, mount
            the host root (Helm uses{" "}
            <span className="font-mono text-xs">/host</span>), then run{" "}
            <span className="font-mono text-xs">heimdall-agent scan-host</span>{" "}
            or set{" "}
            <span className="font-mono text-xs">HEIMDALL_HOST_POSTURE=1</span>.
            See deploy docs — Trivy is optional and not in the default
            distroless image.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2">Severity</th>
                <th className="px-4 py-2">Title</th>
                <th className="px-4 py-2">Package</th>
                <th className="px-4 py-2">Resource</th>
              </tr>
            </thead>
            <tbody>
              {postureFindings.map((f) => (
                <tr key={f.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-mono text-xs">
                    <span
                      className={
                        f.severity === "critical" || f.severity === "high"
                          ? "text-danger"
                          : f.severity === "medium"
                            ? "text-warn"
                            : "text-muted"
                      }
                    >
                      {f.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/security/findings/${f.id}`}
                      className="text-signal underline"
                    >
                      {f.title}
                    </Link>
                    {f.cve ? (
                      <span className="ml-2 font-mono text-xs text-muted">
                        {f.cve}
                      </span>
                    ) : (
                      <span className="ml-2 font-mono text-xs text-muted">
                        {f.external_id}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {f.package_name
                      ? `${f.package_name}@${f.package_version ?? "?"}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">
                    {f.resource ?? "—"}
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

function fmt(v: number | null | undefined) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return Number(v).toFixed(1);
}

function rootDiskPercent(disksJson?: string) {
  if (!disksJson) return null;
  try {
    const disks = JSON.parse(disksJson) as { mountPoint: string; usedPercent: number }[];
    return disks.find((d) => d.mountPoint === "/")?.usedPercent ?? null;
  } catch {
    return null;
  }
}

function MetricCard({
  label,
  value,
  band,
  href,
}: {
  label: string;
  value: string;
  band?: "green" | "yellow" | "red";
  href?: string;
}) {
  const inner = (
    <>
      <div className="flex items-center gap-2">
        {band ? (
          <span
            className={`h-2 w-2 rounded-full ${bandDotClass(band)}`}
            aria-hidden
          />
        ) : null}
        <p className="font-mono text-xs uppercase tracking-wide text-muted">
          {label}
          {href ? " · history" : null}
        </p>
      </div>
      <p
        className={`mt-2 text-2xl font-semibold ${band ? bandTextClass(band) : "text-foreground"}`}
      >
        {value}
      </p>
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        className="border border-border bg-surface px-4 py-4 transition hover:border-signal"
      >
        {inner}
      </Link>
    );
  }
  return (
    <div className="border border-border bg-surface px-4 py-4">{inner}</div>
  );
}

function ChartCard({
  title,
  values,
  href,
}: {
  title: string;
  values: number[];
  href?: string;
}) {
  const heading = href ? (
    <Link href={href} className="text-signal underline">
      {title}
    </Link>
  ) : (
    title
  );
  return (
    <div className="border border-border bg-surface px-4 py-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide">
          {heading}
        </h3>
        <span className="font-mono text-xs text-muted">{values.length} pts</span>
      </div>
      {href ? (
        <Link href={href} className="block">
          <Sparkline values={values} />
        </Link>
      ) : (
        <Sparkline values={values} />
      )}
    </div>
  );
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-wide">
      <span
        className={`h-2 w-2 rounded-full ${online ? "bg-ok" : "bg-danger"}`}
        aria-hidden
      />
      <span className={online ? "text-ok" : "text-danger"}>
        {online ? "online" : "offline"}
      </span>
    </span>
  );
}
