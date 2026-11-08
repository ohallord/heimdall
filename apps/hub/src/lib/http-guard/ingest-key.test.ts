import { beforeEach, describe, expect, it } from "vitest";
import { forgetKnownTokens, guardRate, ingestKey, rememberValidToken } from "./ingest";
import { resetRateLimits } from "./rate-limit";

const req = (token?: string) =>
  new Request("http://hub.test/v1/metrics", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe("ingest rate-limit keys", () => {
  beforeEach(() => {
    resetRateLimits();
    forgetKnownTokens();
    process.env.HEIMDALL_RATE_INGEST = "5/60";
  });

  it("random never-valid tokens share one bucket, so rotating them does not reset the budget", () => {
    const statuses = Array.from({ length: 8 }, (_, i) => guardRate(req(`hdo_random_${i}`), { name: "INGEST", route: "r" }));
    expect(statuses.filter((r) => r === null)).toHaveLength(5);
    expect(statuses.filter((r) => r?.status === 429)).toHaveLength(3);
  });

  it("a token that has authenticated gets its own bucket", () => {
    for (let i = 0; i < 6; i++) guardRate(req(`junk_${i}`), { name: "INGEST", route: "r" });
    rememberValidToken("hdo_good");
    expect(ingestKey(req("hdo_good"), "r")).toMatch(/\|t:/);
    expect(guardRate(req("hdo_good"), { name: "INGEST", route: "r" })).toBeNull();
  });
});
