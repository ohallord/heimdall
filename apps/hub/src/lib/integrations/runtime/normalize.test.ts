import { describe, expect, it } from "vitest";
import {
  falcoPriorityToSeverity,
  normalizeRuntimeEvent,
  normalizeRuntimePayload,
} from "./normalize";

const sampleEvent = {
  output:
    "Warning Unexpected spawned process (user=root command=bash container=nginx)",
  priority: "Warning",
  rule: "Terminal shell in container",
  time: "2026-10-22T18:00:00.000000000Z",
  output_fields: {
    "container.name": "nginx",
    "k8s.pod.name": "web-7d9f",
    "proc.cmdline": "bash",
  },
  hostname: "node-a",
  source: "syscall",
};

describe("runtime normalize", () => {
  it("maps Falco priorities", () => {
    expect(falcoPriorityToSeverity("Critical")).toBe("critical");
    expect(falcoPriorityToSeverity("Error")).toBe("high");
    expect(falcoPriorityToSeverity("Warning")).toBe("medium");
    expect(falcoPriorityToSeverity("Notice")).toBe("low");
  });

  it("normalizes a Falco sidekick event", () => {
    const f = normalizeRuntimeEvent(sampleEvent);
    expect(f).not.toBeNull();
    expect(f!.source).toBe("runtime");
    expect(f!.externalId).toBe("Terminal shell in container");
    expect(f!.title).toBe("Terminal shell in container");
    expect(f!.severity).toBe("medium");
    expect(f!.resource).toBe("web-7d9f");
  });

  it("accepts arrays and events wrappers", () => {
    expect(normalizeRuntimePayload([sampleEvent])).toHaveLength(1);
    expect(normalizeRuntimePayload({ events: [sampleEvent] })).toHaveLength(1);
    expect(normalizeRuntimePayload(sampleEvent)).toHaveLength(1);
    expect(normalizeRuntimePayload(null)).toHaveLength(0);
  });

  it("maps Emergency priority to critical", () => {
    const f = normalizeRuntimeEvent({
      ...sampleEvent,
      priority: "Emergency",
      rule: "Write below binary dir",
    });
    expect(f!.severity).toBe("critical");
  });
});
