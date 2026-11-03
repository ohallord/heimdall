import { describe, expect, it } from "vitest";
import {
  alertFingerprint,
  isMutePreset,
  MUTE_PRESETS_MINUTES,
} from "./fingerprint";

describe("alertFingerprint", () => {
  it("is stable for the same parts", () => {
    const a = alertFingerprint({
      orgId: "org_1",
      ruleOrSource: "rule_cpu",
      agentOrAlarmId: "agt_1",
      metricOrName: "cpu_percent",
    });
    const b = alertFingerprint({
      orgId: "org_1",
      ruleOrSource: "rule_cpu",
      agentOrAlarmId: "agt_1",
      metricOrName: "cpu_percent",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when any part changes", () => {
    const base = {
      orgId: "org_1",
      ruleOrSource: "rule_cpu",
      agentOrAlarmId: "agt_1",
      metricOrName: "cpu_percent",
    };
    expect(alertFingerprint({ ...base, orgId: "org_2" })).not.toBe(
      alertFingerprint(base),
    );
    expect(alertFingerprint({ ...base, metricOrName: "mem_percent" })).not.toBe(
      alertFingerprint(base),
    );
  });
});

describe("mute presets", () => {
  it("accepts design presets only", () => {
    expect(MUTE_PRESETS_MINUTES).toEqual([15, 30, 60, 240]);
    expect(isMutePreset(30)).toBe(true);
    expect(isMutePreset(45)).toBe(false);
  });
});
