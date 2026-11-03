import { describe, expect, it } from "vitest";
import type { K8sClusterMetric } from "@/lib/db/types";
import {
  countK8sProblems,
  isK8sCollectionEnabled,
  k8sApiDisplay,
  k8sApiLabel,
} from "./k8s-status";

function base(partial: Partial<K8sClusterMetric> = {}): K8sClusterMetric {
  return {
    clusterId: "default",
    apiServerReachable: false,
    nodesTotal: 0,
    nodesReady: 0,
    podsPending: 0,
    podsCrashLoop: 0,
    deploymentsTotal: 0,
    deploymentsUnhealthy: 0,
    ...partial,
  };
}

describe("k8s status display", () => {
  it("shows Disabled when enabled=false (never API down)", () => {
    const k8s = base({ enabled: false, apiServerReachable: false });
    expect(isK8sCollectionEnabled(k8s)).toBe(false);
    expect(k8sApiDisplay(k8s)).toBe("disabled");
    expect(k8sApiLabel(k8s)).toBe("Disabled");
    expect(countK8sProblems(k8s)).toBe(0);
  });

  it("shows down only when enabled and API unreachable", () => {
    const k8s = base({
      enabled: true,
      apiServerReachable: false,
      apiServerError: "connection refused",
      nodesTotal: 0,
      nodesReady: 0,
    });
    expect(isK8sCollectionEnabled(k8s)).toBe(true);
    expect(k8sApiDisplay(k8s)).toBe("down");
    expect(k8sApiLabel(k8s)).toBe("down");
    expect(countK8sProblems(k8s)).toBe(1);
  });

  it("shows reachable when enabled and API up", () => {
    const k8s = base({
      enabled: true,
      apiServerReachable: true,
      nodesTotal: 2,
      nodesReady: 2,
    });
    expect(k8sApiDisplay(k8s)).toBe("reachable");
    expect(countK8sProblems(k8s)).toBe(0);
  });

  it("treats legacy empty unreachable sample as disabled", () => {
    const k8s = base({ apiServerReachable: false, nodesTotal: 0 });
    expect(isK8sCollectionEnabled(k8s)).toBe(false);
    expect(k8sApiDisplay(k8s)).toBe("disabled");
  });

  it("treats legacy unreachable with error as enabled/down", () => {
    const k8s = base({
      apiServerReachable: false,
      apiServerError: "i/o timeout",
      nodesTotal: 0,
    });
    expect(isK8sCollectionEnabled(k8s)).toBe(true);
    expect(k8sApiDisplay(k8s)).toBe("down");
  });

  it("null sample is disabled", () => {
    expect(isK8sCollectionEnabled(null)).toBe(false);
    expect(k8sApiDisplay(null)).toBe("disabled");
  });
});
