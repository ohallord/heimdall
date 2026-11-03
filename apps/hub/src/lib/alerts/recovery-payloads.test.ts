import { describe, expect, it } from "vitest";
import type { ResolvedAlertEvent } from "@/lib/db/store";
import { buildRecoveryPayloads } from "./recovery";

const rule = {
  id: "rule_disk",
  name: "High disk",
  operator: "gte" as const,
  threshold: 90,
  alarm_threshold: 90,
};

function ev(over: Partial<ResolvedAlertEvent> = {}): ResolvedAlertEvent {
  return {
    id: "evt_1",
    ruleId: "rule_disk",
    fingerprint: "fp1",
    severity: "critical",
    previousStatus: "open",
    createdAt: "2026-11-02T10:00:00.000Z",
    payload: {
      agentId: "agt_1",
      hostname: "edge-01",
      band: "red",
      sample: { metric: "disk_percent:/var", value: 95 },
    },
    ...over,
  };
}

const now = new Date("2026-11-02T10:12:00.000Z");

describe("buildRecoveryPayloads", () => {
  it("builds an info-severity recovery with duration and current value", () => {
    const [p, ...rest] = buildRecoveryPayloads({
      resolved: [ev()],
      rules: [rule],
      hostname: "edge-01",
      samples: [{ metric: "disk_percent:/var", value: 41.26 }],
      now,
    });
    expect(rest).toHaveLength(0);
    expect(p.kind).toBe("recovery");
    expect(p.severity).toBe("info");
    expect(p.subject).toBe("High disk on edge-01");
    expect(p.message).toBe("Disk usage (/var) is back to normal at 41.3% after 12m.");
    expect(p.deepLink).toBe("/dashboard/alerts?id=evt_1");
    expect(p.fields).toContainEqual({ label: "Duration", value: "12m" });
    expect(p.fields).toContainEqual({ label: "Alarm threshold", value: "≥ 90%" });
  });

  it("skips muted and warn-only (yellow) alerts that never notified", () => {
    const out = buildRecoveryPayloads({
      resolved: [
        ev({ previousStatus: "muted" }),
        ev({ id: "evt_2", fingerprint: "fp2", payload: { ...ev().payload, band: "yellow" } }),
      ],
      rules: [rule],
      hostname: "edge-01",
      samples: [],
      now,
    });
    expect(out).toHaveLength(0);
  });

  it("sends one recovery per fingerprint, linking the newest event", () => {
    const out = buildRecoveryPayloads({
      resolved: [
        ev({ id: "evt_new", createdAt: "2026-11-02T10:10:00.000Z" }),
        ev({ id: "evt_old", createdAt: "2026-11-02T09:00:00.000Z" }),
      ],
      rules: [rule],
      hostname: "edge-01",
      samples: [],
      now,
    });
    expect(out).toHaveLength(1);
    expect(out[0].deepLink).toContain("evt_new");
    expect(out[0].fields).toContainEqual({ label: "Duration", value: "1h 12m" });
  });

  it("phrases mount recoveries by path", () => {
    const [p] = buildRecoveryPayloads({
      resolved: [
        ev({
          ruleId: "rule_mount",
          payload: {
            hostname: "edge-01",
            band: "alarm",
            mountPath: "/data",
            sample: { metric: "mount_missing:/data", value: 1 },
          },
        }),
      ],
      rules: [{ ...rule, id: "rule_mount", name: "Mount missing", threshold: 1, alarm_threshold: null }],
      hostname: "edge-01",
      samples: [],
      now,
    });
    expect(p.subject).toBe("Mount missing on edge-01");
    expect(p.message).toBe("Mount /data is back after 12m.");
  });

  it("phrases container exit recoveries by container name", () => {
    const [p] = buildRecoveryPayloads({
      resolved: [
        ev({
          ruleId: "rule_ctr",
          payload: {
            hostname: "edge-01",
            band: "alarm",
            sample: { metric: "container_exited:jellyfin", value: 1 },
          },
        }),
      ],
      rules: [{ ...rule, id: "rule_ctr", name: "Container exited", threshold: 1, alarm_threshold: null }],
      hostname: "edge-01",
      samples: [],
      now,
    });
    expect(p.subject).toBe("Container exited on edge-01");
    expect(p.message).toBe(
      "Container jellyfin is no longer exited (running again or removed) after 12m.",
    );
    expect(p.fields.map((f) => f.label)).not.toContain("Alarm threshold");
  });
});
