import { describe, expect, it } from "vitest";
import { tokenState, type EnrollmentTokenView } from "./agent-tokens-panel";

const base: EnrollmentTokenView = {
  id: "tok_1",
  name: "web",
  hint: "hdt_ab…wxyz",
  createdAt: "2026-11-01T00:00:00.000Z",
  expiresAt: null,
  maxUses: null,
  useCount: 0,
  revokedAt: null,
};
const now = Date.parse("2026-11-02T00:00:00.000Z");

describe("tokenState", () => {
  it("orders revoked > expired > used up > active", () => {
    expect(tokenState(base, now)).toBe("active");
    expect(tokenState({ ...base, maxUses: 1, useCount: 1 }, now)).toBe("used up");
    expect(tokenState({ ...base, expiresAt: "2026-11-01T12:00:00.000Z", maxUses: 1, useCount: 1 }, now)).toBe("expired");
    expect(tokenState({ ...base, revokedAt: "2026-11-01T01:00:00.000Z", expiresAt: "2026-11-01T12:00:00.000Z" }, now)).toBe("revoked");
    expect(tokenState({ ...base, expiresAt: "2026-11-03T00:00:00.000Z", maxUses: 5, useCount: 2 }, now)).toBe("active");
  });
});
