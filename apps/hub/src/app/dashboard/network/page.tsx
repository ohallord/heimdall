import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { getSession } from "@/lib/auth/session";
import { getActiveClusterId } from "@/lib/clusters/store";
import type { K8sClusterMetric } from "@/lib/db/types";
import { isSetupComplete } from "@/lib/db/store";
import {
  groupUnifiEvents,
  listUnifiAlertEvents,
} from "@/lib/integrations/unifi/ingest";
import { listClusterK8sSummaries } from "@/lib/metrics/ingest";
import { listOtelMetricSamples } from "@/lib/otel/ingest";

export const dynamic = "force-dynamic";

function pickExposureSummary(
  summaries: Array<{ clusterId: string; summary: K8sClusterMetric }>,
  activeClusterId: string,
): { clusterId: string; summary: K8sClusterMetric } | null {
  if (summaries.length === 0) return null;
  const active = summaries.find((s) => s.clusterId === activeClusterId);
  if (active) return active;
  return summaries[0] ?? null;
}

export default async function NetworkPage() {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const orgId = session.orgId!;
  const [events, otelSamples, activeClusterId, k8sSummaries] =
    await Promise.all([
      listUnifiAlertEvents(orgId, 50),
      listOtelMetricSamples(orgId, { limit: 20 }),
      getActiveClusterId(orgId),
      listClusterK8sSummaries(orgId),
    ]);
  const grouped = groupUnifiEvents(events);
  const exposure = pickExposureSummary(k8sSummaries, activeClusterId);
  const exposedServices = exposure?.summary.exposedServices ?? [];
  const networkPolicy = exposure?.summary.networkPolicy;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Network
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          UniFi & OTEL
        </h1>
        <p className="mt-2 text-sm text-muted">
          Alarm Manager webhooks (grouped by type and device), Kubernetes
          exposure / NetworkPolicy posture, and recent OpenTelemetry points.
          Named services aggregate on{" "}
          <Link href="/dashboard/services" className="text-signal underline">
            Services
          </Link>
          . Integration tokens live under Settings.
        </p>
      </header>

      <section className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            UniFi alerts
          </h2>
        </div>
        {events.length === 0 ? (
          <EmptyState>
            No UniFi webhook events yet. Configure Alarm Manager → Heimdall (see
            docs/unifi.md) and rotate a token under Settings.
          </EmptyState>
        ) : (
          <div className="divide-y divide-border">
            {grouped.map((bucket) => (
              <div key={bucket.typeKey} className="px-4 py-4">
                <h3 className="text-sm font-semibold">{bucket.typeKey}</h3>
                <div className="mt-3 flex flex-col gap-4">
                  {bucket.devices.map((dev) => (
                    <div key={`${bucket.typeKey}:${dev.deviceKey}`}>
                      <p className="font-mono text-xs uppercase tracking-wide text-muted">
                        {dev.deviceKey}
                      </p>
                      <table className="mt-2 w-full text-left text-sm">
                        <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
                          <tr>
                            <th className="px-3 py-2 font-medium">When</th>
                            <th className="px-3 py-2 font-medium">Severity</th>
                            <th className="px-3 py-2 font-medium">Message</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dev.events.map((e) => (
                            <tr
                              key={e.id}
                              className="border-b border-border last:border-0"
                            >
                              <td className="px-3 py-2 font-mono text-xs text-muted whitespace-nowrap">
                                {new Date(e.created_at).toISOString()}
                              </td>
                              <td className="px-3 py-2 font-mono text-xs">
                                <span
                                  className={
                                    e.severity === "critical"
                                      ? "text-danger"
                                      : e.severity === "warning"
                                        ? "text-warn"
                                        : "text-muted"
                                  }
                                >
                                  {e.severity}
                                </span>
                              </td>
                              <td className="px-3 py-2">{e.message}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            K8s exposure
          </h2>
          {exposure ? (
            <p className="mt-1 font-mono text-xs text-muted">
              Cluster {exposure.clusterId}
              {networkPolicy
                ? ` · NetworkPolicy: ${networkPolicy.namespacesWithPolicy}/${networkPolicy.namespacesTotal} namespaces covered (${networkPolicy.namespacesWithoutPolicy} without)`
                : " · NetworkPolicy summary unavailable (upgrade agent / RBAC)"}
            </p>
          ) : null}
        </div>
        {!exposure || exposedServices.length === 0 ? (
          <EmptyState>
            {exposure
              ? "No NodePort / LoadBalancer / ExternalIP Services reported for this cluster."
              : "No Kubernetes summaries yet. Enable the agent with K8s collection (docs/network-security.md)."}
          </EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Namespace</th>
                <th className="px-4 py-2 font-medium">Service</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Exposure</th>
              </tr>
            </thead>
            <tbody>
              {exposedServices.map((s) => {
                const bits: string[] = [];
                if (s.nodePorts?.length)
                  bits.push(`ports ${s.nodePorts.join(",")}`);
                if (s.externalIPs?.length)
                  bits.push(`ext ${s.externalIPs.join(",")}`);
                if (s.loadBalancerHosts?.length)
                  bits.push(`lb ${s.loadBalancerHosts.join(",")}`);
                return (
                  <tr
                    key={`${s.namespace}/${s.name}`}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-4 py-3 font-mono text-xs">{s.namespace}</td>
                    <td className="px-4 py-3 font-mono text-xs">{s.name}</td>
                    <td className="px-4 py-3 font-mono text-xs">{s.type}</td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {bits.length ? bits.join(" · ") : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {networkPolicy?.withoutPolicy &&
        networkPolicy.withoutPolicy.length > 0 ? (
          <div className="border-t border-border px-4 py-3">
            <p className="font-mono text-xs uppercase tracking-wide text-muted">
              Namespaces without NetworkPolicy
            </p>
            <p className="mt-2 font-mono text-xs text-muted">
              {networkPolicy.withoutPolicy.join(", ")}
            </p>
          </div>
        ) : null}
      </section>

      <section className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Recent OTEL points
          </h2>
        </div>
        {otelSamples.length === 0 ? (
          <EmptyState>
            No OTLP samples yet. Point a collector at /v1/metrics with JSON
            encoding (docs/otel.md).
          </EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Metric</th>
                <th className="px-4 py-2 font-medium">Value</th>
                <th className="px-4 py-2 font-medium">Host / service</th>
              </tr>
            </thead>
            <tbody>
              {otelSamples.map((s) => (
                <tr key={s.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-mono text-xs text-muted whitespace-nowrap">
                    {new Date(s.collected_at).toISOString()}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {s.metric_name}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {Number(s.value).toFixed(4)}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {s.resource_host ?? s.resource_service ?? "—"}
                    {s.agent_id ? (
                      <span className="ml-2 font-mono">({s.agent_id})</span>
                    ) : null}
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
