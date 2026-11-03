import { describe, expect, it, beforeEach } from "vitest";
import {
  alertCooldownKey,
  resetAlertCooldowns,
  shouldFireAlert,
} from "./cooldown";

describe("alert cooldown", () => {
  beforeEach(() => {
    resetAlertCooldowns();
  });

  it("allows first fire then suppresses within window", () => {
    const key = alertCooldownKey({
      orgId: "org",
      ruleId: "rul",
      agentId: "agt",
      metric: "mount_missing",
    });
    const t0 = 1_000_000;
    expect(shouldFireAlert(key, t0, 60_000)).toBe(true);
    expect(shouldFireAlert(key, t0 + 30_000, 60_000)).toBe(false);
    expect(shouldFireAlert(key, t0 + 60_000, 60_000)).toBe(true);
  });

  it("defaults to a long cooldown window", async () => {
    const { DEFAULT_ALERT_COOLDOWN_MS } = await import("./cooldown");
    expect(DEFAULT_ALERT_COOLDOWN_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
  });
});
