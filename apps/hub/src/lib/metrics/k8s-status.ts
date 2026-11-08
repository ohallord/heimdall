import type { K8sClusterMetric } from "@/lib/db/types";

/** Partial snapshot fields used by fleet / cluster UI. */
export type K8sStatusInput = Partial<K8sClusterMetric> | null | undefined;

/**
 * Whether the agent is collecting Kubernetes health.
 * `enabled: false` is explicit (Compose / bare hosts).
 * Legacy samples without `enabled` that look empty+unreachable are treated as disabled
 * so homelab never shows a false "API: down" after K8s was turned off.
 */
export function isK8sCollectionEnabled(k8s: K8sStatusInput): boolean {
  if (!k8s) return false;
  if (k8s.enabled === false) return false;
  if (k8s.enabled === true) return true;
  // Legacy: no flag, unreachable, no nodes, no error string → treat as disabled.
  if (
    !k8s.apiServerReachable &&
    (k8s.nodesTotal ?? 0) === 0 &&
    !(k8s.apiServerError && String(k8s.apiServerError).trim())
  ) {
    return false;
  }
  return true;
}

export type K8sApiDisplay = "disabled" | "reachable" | "down";

/** API column: Disabled vs reachable vs down (never "down" when collection is off). */
export function k8sApiDisplay(k8s: K8sStatusInput): K8sApiDisplay {
  if (!isK8sCollectionEnabled(k8s)) return "disabled";
  return k8s!.apiServerReachable ? "reachable" : "down";
}

export function k8sApiLabel(k8s: K8sStatusInput): string {
  const d = k8sApiDisplay(k8s);
  if (d === "disabled") return "Disabled";
  if (d === "reachable") return "reachable";
  return "down";
}

/** Problem count for fleet tiles — zero when collection is disabled. */
export function countK8sProblems(k8s: K8sStatusInput): number {
  if (!isK8sCollectionEnabled(k8s) || !k8s) return 0;
  return (
    Math.max(0, (k8s.nodesTotal ?? 0) - (k8s.nodesReady ?? 0)) +
    (k8s.podsPending ?? 0) +
    (k8s.podsCrashLoop ?? 0) +
    (k8s.deploymentsUnhealthy ?? 0) +
    (k8s.apiServerReachable ? 0 : 1)
  );
}
