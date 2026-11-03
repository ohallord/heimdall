import { redirect } from "next/navigation";
import { ClusterManager } from "@/components/cluster-manager";
import { getSession } from "@/lib/auth/session";
import {
  getActiveClusterId,
  listClusters,
} from "@/lib/clusters/store";
import { isSetupComplete } from "@/lib/db/store";
import { listClusterK8sSummaries } from "@/lib/metrics/ingest";
import { can } from "@/lib/rbac/permissions";

export const dynamic = "force-dynamic";

export default async function ClustersPage() {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const orgId = session.orgId!;
  const [clusters, activeClusterId, k8s] = await Promise.all([
    listClusters(orgId),
    getActiveClusterId(orgId),
    listClusterK8sSummaries(orgId),
  ]);
  const k8sById = new Map(k8s.map((k) => [k.clusterId, k.summary]));

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Kubernetes · Clusters
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Kubernetes clusters
        </h1>
        <p className="mt-2 text-sm text-muted">
          Switch the active cluster used by the fleet K8s summary. Agents report
          a <code className="font-mono text-xs">cluster_id</code> on register /
          metrics ingest.
        </p>
      </header>

      <ClusterManager
        activeClusterId={activeClusterId}
        canWrite={can(session.role!, "settings:write")}
        initialClusters={clusters.map((c) => ({
          clusterId: c.cluster_id,
          name: c.name,
          isActive: Boolean(c.is_active) || c.cluster_id === activeClusterId,
          kubernetes: k8sById.get(c.cluster_id)
            ? {
                clusterId: k8sById.get(c.cluster_id)!.clusterId,
                enabled: k8sById.get(c.cluster_id)!.enabled,
                nodesReady: k8sById.get(c.cluster_id)!.nodesReady,
                nodesTotal: k8sById.get(c.cluster_id)!.nodesTotal,
                podsPending: k8sById.get(c.cluster_id)!.podsPending,
                podsCrashLoop: k8sById.get(c.cluster_id)!.podsCrashLoop,
                deploymentsUnhealthy:
                  k8sById.get(c.cluster_id)!.deploymentsUnhealthy,
                apiServerReachable:
                  k8sById.get(c.cluster_id)!.apiServerReachable,
                apiServerError: k8sById.get(c.cluster_id)!.apiServerError,
              }
            : null,
        }))}
      />
    </main>
  );
}
