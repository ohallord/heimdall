import type { K8sPodMetric } from "@/lib/db/types";

/** Pods that are not healthy (pending / crash / failed). */
export function filterProblemPods(pods: K8sPodMetric[]): K8sPodMetric[] {
  return pods.filter((p) => p.healthy === false);
}

/** Sort unhealthy first, then namespace/name. */
export function sortPodsForDisplay(pods: K8sPodMetric[]): K8sPodMetric[] {
  return [...pods].sort((a, b) => {
    if (a.healthy !== b.healthy) return a.healthy ? 1 : -1;
    const ns = (a.namespace || "").localeCompare(b.namespace || "");
    if (ns !== 0) return ns;
    return (a.name || "").localeCompare(b.name || "");
  });
}

export function podHealthTone(
  pod: Pick<K8sPodMetric, "healthy" | "phase">,
): "ok" | "warn" | "danger" | "muted" {
  if (pod.healthy) return "ok";
  const phase = (pod.phase || "").toLowerCase();
  if (phase === "failed" || phase === "unknown") return "danger";
  if (phase === "pending" || phase === "running") return "warn";
  return "muted";
}

export function formatPodReady(ready: string | undefined): string {
  const r = (ready || "").trim();
  return r || "—";
}
