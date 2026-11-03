import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeUnifiWebhook } from "./normalize";

const fixtures = join(__dirname, "fixtures");

describe("normalizeUnifiWebhook", () => {
  it("normalizes Network WAN offline payload to critical", () => {
    const body = JSON.parse(
      readFileSync(join(fixtures, "network-wan.json"), "utf8"),
    );
    const n = normalizeUnifiWebhook(body);
    expect(n.severity).toBe("critical");
    expect(n.app).toBe("network");
    expect(n.name).toBe("Internet Disconnected");
    expect(n.message).toContain("Internet connection lost");
    expect(n.alarmId).toBe("01993ab8-13af-7710-872c-d6a0eceda27a");
    expect(n.device).toBe("UDM-Pro");
    expect(n.category).toBe("Internet / WAN");
  });

  it("normalizes Protect-shaped motion payload", () => {
    const body = JSON.parse(
      readFileSync(join(fixtures, "protect-motion.json"), "utf8"),
    );
    const n = normalizeUnifiWebhook(body);
    expect(n.app).toBe("protect");
    expect(n.name).toBe("Front porch motion");
    expect(n.message).toContain("motion @ 74ACB99F4E24");
    expect(n.severity).toBe("warning");
    expect(n.device).toBe("74ACB99F4E24");
    expect(n.category).toBeNull();
  });
});
