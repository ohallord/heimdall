import { describe, expect, it } from "vitest";
import { findPodInSample, podDetailHref } from "./find-pod";
import type { K8sClusterMetric } from "@/lib/db/types";

const sample: K8sClusterMetric = {
  clusterId: "default",
  apiServerReachable: true,
  nodesTotal: 1,
  nodesReady: 1,
  podsPending: 0,
  podsCrashLoop: 0,
  deploymentsTotal: 0,
  deploymentsUnhealthy: 0,
  pods: [
    {
      namespace: "heimdall",
      name: "hub-0",
      phase: "Running",
      ready: "1/1",
      restarts: 0,
      healthy: true,
    },
  ],
};

describe("findPodInSample", () => {
  it("finds by ns/name", () => {
    expect(findPodInSample(sample, "heimdall", "hub-0")?.name).toBe("hub-0");
  });

  it("returns null when missing", () => {
    expect(findPodInSample(sample, "default", "missing")).toBeNull();
    expect(findPodInSample(null, "heimdall", "hub-0")).toBeNull();
  });
});

describe("podDetailHref", () => {
  it("encodes path and optional agent", () => {
    expect(podDetailHref("kube-system", "coredns")).toBe(
      "/dashboard/k8s/pods/kube-system/coredns",
    );
    expect(podDetailHref("ns", "pod", "agt_1")).toBe(
      "/dashboard/k8s/pods/ns/pod?agent=agt_1",
    );
  });
});
