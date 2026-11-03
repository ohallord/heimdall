import { describe, expect, it } from "vitest";
import type { ContainerMetric } from "@/lib/db/types";
import {
  containerStateTone,
  filterContainers,
  isHeimdallStackContainer,
  truncateImageRef,
} from "./containers-display";

function ctr(partial: Partial<ContainerMetric>): ContainerMetric {
  return {
    id: "c1",
    name: "app",
    image: "nginx:latest",
    state: "running",
    status: "Up",
    restartCount: 0,
    ...partial,
  };
}

describe("truncateImageRef", () => {
  it("shortens bare sha256 digests", () => {
    const dig =
      "sha256:8aa3c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d";
    expect(truncateImageRef(dig)).toBe("sha256:8aa3c0f1…");
    expect(truncateImageRef(dig).length).toBeLessThan(dig.length);
  });

  it("leaves tagged images alone", () => {
    expect(truncateImageRef("postgres:16-alpine")).toBe("postgres:16-alpine");
  });
});

describe("filterContainers", () => {
  it("defaults to running only", () => {
    const list = [
      ctr({ id: "1", state: "running" }),
      ctr({ id: "2", state: "exited" }),
      ctr({ id: "3", state: "created" }),
    ];
    expect(filterContainers(list, { showStopped: false }).map((c) => c.id)).toEqual([
      "1",
    ]);
    expect(filterContainers(list, { showStopped: true })).toHaveLength(3);
  });
});

describe("container helpers", () => {
  it("tones and heimdall stack detection", () => {
    expect(containerStateTone("running")).toBe("running");
    expect(containerStateTone("exited")).toBe("exited");
    expect(containerStateTone("created")).toBe("created");
    expect(isHeimdallStackContainer({ name: "heimdall-hub-1", image: "x" })).toBe(
      true,
    );
    expect(isHeimdallStackContainer({ name: "worker", image: "nginx" })).toBe(false);
  });
});
