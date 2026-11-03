import { describe, expect, it } from "vitest";
import type { K8sPodMetric } from "@/lib/db/types";
import {
  filterProblemPods,
  formatPodReady,
  podHealthTone,
  sortPodsForDisplay,
} from "./k8s-pods-display";

function pod(partial: Partial<K8sPodMetric> & Pick<K8sPodMetric, "name">): K8sPodMetric {
  return {
    namespace: "default",
    phase: "Running",
    ready: "1/1",
    restarts: 0,
    healthy: true,
    ...partial,
  };
}

describe("k8s pods display", () => {
  it("sorts unhealthy first then namespace/name", () => {
    const sorted = sortPodsForDisplay([
      pod({ name: "b", namespace: "z", healthy: true }),
      pod({ name: "a", namespace: "a", healthy: false, phase: "Pending" }),
      pod({ name: "c", namespace: "a", healthy: true }),
    ]);
    expect(sorted.map((p) => `${p.namespace}/${p.name}`)).toEqual([
      "a/a",
      "a/c",
      "z/b",
    ]);
  });

  it("filters problem pods", () => {
    const list = [
      pod({ name: "ok", healthy: true }),
      pod({ name: "bad", healthy: false, phase: "Pending" }),
    ];
    expect(filterProblemPods(list).map((p) => p.name)).toEqual(["bad"]);
  });

  it("tones healthy / pending / failed", () => {
    expect(podHealthTone(pod({ name: "ok", healthy: true }))).toBe("ok");
    expect(
      podHealthTone(pod({ name: "p", healthy: false, phase: "Pending" })),
    ).toBe("warn");
    expect(
      podHealthTone(pod({ name: "f", healthy: false, phase: "Failed" })),
    ).toBe("danger");
  });

  it("formats ready column", () => {
    expect(formatPodReady("1/1")).toBe("1/1");
    expect(formatPodReady("")).toBe("—");
    expect(formatPodReady(undefined)).toBe("—");
  });
});
