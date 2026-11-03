import type { K8sClusterMetric, K8sPodMetric } from "@/lib/db/types";

/** Find a pod in a cluster snapshot by namespace + name. */
export function findPodInSample(
  k8s: K8sClusterMetric | null | undefined,
  namespace: string,
  name: string,
): K8sPodMetric | null {
  if (!k8s?.pods?.length) return null;
  const ns = decodeURIComponent(namespace);
  const n = decodeURIComponent(name);
  return (
    k8s.pods.find((p) => p.namespace === ns && p.name === n) ?? null
  );
}

export function podDetailHref(
  namespace: string,
  name: string,
  agentId?: string | null,
): string {
  const base = `/dashboard/k8s/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
  if (agentId) return `${base}?agent=${encodeURIComponent(agentId)}`;
  return base;
}
