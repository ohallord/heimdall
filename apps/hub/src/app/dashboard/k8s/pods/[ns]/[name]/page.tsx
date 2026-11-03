import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete } from "@/lib/db/store";
import type { K8sClusterMetric, K8sPodMetric } from "@/lib/db/types";
import { findPodInSample } from "@/lib/metrics/find-pod";
import {
  getActiveClusterK8s,
  getAgentById,
  getLatestK8s,
} from "@/lib/metrics/ingest";
import { podHealthTone } from "@/lib/metrics/k8s-pods-display";

export const dynamic = "force-dynamic";

const toneClass: Record<ReturnType<typeof podHealthTone>, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  muted: "text-muted",
};

export default async function PodDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ ns: string; name: string }>;
  searchParams: Promise<{ agent?: string }>;
}) {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const { ns, name } = await params;
  const { agent: agentParam } = await searchParams;

  let k8s: K8sClusterMetric | null = null;
  let agentId: string | null = null;
  let agentHostname: string | null = null;
  let collectedAt: string | null = null;

  if (agentParam) {
    const agent = await getAgentById(agentParam);
    if (!agent || (session.orgId && agent.org_id !== session.orgId)) {
      notFound();
    }
    agentId = agent.id;
    agentHostname = agent.hostname;
    const row = await getLatestK8s(agent.id);
    if (row) {
      k8s = JSON.parse(row.summary_json) as K8sClusterMetric;
      collectedAt = row.collected_at;
    }
  } else {
    const active = session.orgId
      ? await getActiveClusterK8s(session.orgId)
      : null;
    if (active) {
      k8s = active.summary;
      agentId = active.row.agent_id;
      collectedAt = active.row.collected_at;
      const agent = await getAgentById(active.row.agent_id);
      agentHostname = agent?.hostname ?? null;
    }
  }

  const pod = findPodInSample(k8s, ns, name);
  if (!pod) {
    notFound();
  }

  const tone = podHealthTone(pod);
  const backHref = agentId
    ? `/dashboard/hosts/${agentId}`
    : "/dashboard#kubernetes";

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Kubernetes · pod
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          <span className="text-muted">{decodeURIComponent(ns)}/</span>
          {decodeURIComponent(name)}
        </h1>
        <p className="mt-2 font-mono text-xs text-muted">
          phase{" "}
          <span className={toneClass[tone]}>{pod.phase}</span>
          {" · "}
          ready {pod.ready || "—"}
          {" · "}
          restarts {pod.restarts}
          {pod.nodeName ? ` · node ${pod.nodeName}` : ""}
          {agentHostname ? ` · agent ${agentHostname}` : ""}
          {collectedAt
            ? ` · sample ${new Date(collectedAt).toISOString()}`
            : ""}
        </p>
        <p className="mt-3 text-sm">
          <Link href={backHref} className="text-signal underline">
            ← {agentId ? "Host" : "Kubernetes"}
          </Link>
        </p>
      </header>

      <OverviewSection pod={pod} />
      <ConditionsSection pod={pod} />
      <ContainersSection pod={pod} />
      <ResourcesSection pod={pod} />
      <EventsSection pod={pod} />
      <LogsSection pod={pod} />
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function OverviewSection({ pod }: { pod: K8sPodMetric }) {
  return (
    <Section title="Overview">
      <dl className="grid gap-3 px-4 py-4 font-mono text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted">Reason</dt>
          <dd>{pod.reason || "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Healthy</dt>
          <dd>{pod.healthy ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt className="text-muted">Created</dt>
          <dd>{pod.createdAt || "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Node</dt>
          <dd>{pod.nodeName || "—"}</dd>
        </div>
      </dl>
    </Section>
  );
}

function ConditionsSection({ pod }: { pod: K8sPodMetric }) {
  const rows = pod.conditions ?? [];
  return (
    <Section title="Conditions">
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">
          No conditions in this sample (older agent or empty status).
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Reason</th>
              <th className="px-4 py-2 font-medium">Message</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.type}
                className="border-b border-border last:border-0 font-mono text-xs"
              >
                <td className="px-4 py-2">{c.type}</td>
                <td className="px-4 py-2">{c.status}</td>
                <td className="px-4 py-2 text-muted">{c.reason || "—"}</td>
                <td className="px-4 py-2 text-muted">{c.message || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function ContainersSection({ pod }: { pod: K8sPodMetric }) {
  const rows = pod.containers ?? [];
  return (
    <Section title="Containers">
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">
          No container statuses in this sample.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Image</th>
              <th className="px-4 py-2 font-medium">State</th>
              <th className="px-4 py-2 font-medium">Ready</th>
              <th className="px-4 py-2 font-medium">Restarts</th>
              <th className="px-4 py-2 font-medium">Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.name}
                className="border-b border-border last:border-0 font-mono text-xs"
              >
                <td className="px-4 py-2">{c.name}</td>
                <td className="px-4 py-2 text-muted">{c.image || "—"}</td>
                <td className="px-4 py-2">{c.state || "—"}</td>
                <td className="px-4 py-2">{c.ready ? "yes" : "no"}</td>
                <td className="px-4 py-2">{c.restarts}</td>
                <td className="px-4 py-2 text-muted">{c.reason || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function ResourcesSection({ pod }: { pod: K8sPodMetric }) {
  const r = pod.resources;
  const empty =
    !r ||
    (!r.cpuRequest && !r.cpuLimit && !r.memRequest && !r.memLimit);
  return (
    <Section title="Resources">
      {empty ? (
        <p className="px-4 py-6 text-sm text-muted">
          No requests/limits on the pod spec. Live usage requires metrics-server
          (not required for this view).
        </p>
      ) : (
        <dl className="grid gap-3 px-4 py-4 font-mono text-xs sm:grid-cols-2">
          <div>
            <dt className="text-muted">CPU request</dt>
            <dd>{r?.cpuRequest || "—"}</dd>
          </div>
          <div>
            <dt className="text-muted">CPU limit</dt>
            <dd>{r?.cpuLimit || "—"}</dd>
          </div>
          <div>
            <dt className="text-muted">Memory request</dt>
            <dd>{r?.memRequest || "—"}</dd>
          </div>
          <div>
            <dt className="text-muted">Memory limit</dt>
            <dd>{r?.memLimit || "—"}</dd>
          </div>
        </dl>
      )}
    </Section>
  );
}

function EventsSection({ pod }: { pod: K8sPodMetric }) {
  const rows = pod.events ?? [];
  return (
    <Section title="Events">
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">
          No recent events (unavailable or empty). Ensure agent RBAC includes
          events get/list/watch.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Reason</th>
              <th className="px-4 py-2 font-medium">Count</th>
              <th className="px-4 py-2 font-medium">Last</th>
              <th className="px-4 py-2 font-medium">Message</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr
                key={`${e.reason}-${e.lastTimestamp}-${i}`}
                className="border-b border-border last:border-0 font-mono text-xs"
              >
                <td className="px-4 py-2">{e.type || "—"}</td>
                <td className="px-4 py-2">{e.reason || "—"}</td>
                <td className="px-4 py-2">{e.count ?? "—"}</td>
                <td className="px-4 py-2 text-muted">
                  {e.lastTimestamp || "—"}
                </td>
                <td className="px-4 py-2 text-muted">{e.message || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function LogsSection({ pod }: { pod: K8sPodMetric }) {
  const tail = (pod.logTail || "").trim();
  return (
    <Section title="Logs">
      {tail ? (
        <pre className="max-h-96 overflow-auto px-4 py-4 font-mono text-xs whitespace-pre-wrap">
          {tail}
        </pre>
      ) : (
        <p className="px-4 py-6 text-sm text-muted">
          No log tail in this sample. Unhealthy pods include a short tail when
          the agent has pods/log get access; healthy pods omit logs to keep
          payloads small.
        </p>
      )}
    </Section>
  );
}
