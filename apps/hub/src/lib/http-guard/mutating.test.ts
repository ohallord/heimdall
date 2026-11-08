import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mutating } from "./mutating";

/** Token-auth routes with no cookies: intentionally not CSRF-wrapped (keep in sync with mutating.ts doc). */
const EXEMPT = new Set([
  "api/v1/agents/register/route.ts",
  "api/v1/agents/heartbeat/route.ts",
  "api/v1/agents/metrics/route.ts",
  "api/v1/agents/logs/route.ts",
  "api/v1/agents/vulns/route.ts",
  "api/v1/integrations/unifi/webhook/route.ts",
  "api/v1/integrations/runtime/webhook/route.ts",
  "v1/metrics/route.ts",
  "v1/logs/route.ts",
  "v1/traces/route.ts",
  "mcp/route.ts",
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n === "route.ts" ? [p] : [];
  });
}

describe("mutating()", () => {
  const post = (headers: Record<string, string>) =>
    new Request("http://hub.test/x", { method: "POST", headers });

  it("403s cross-origin before the handler runs", async () => {
    const h = vi.fn(async () => new Response("ok"));
    const res = await mutating(h)(post({ origin: "https://evil.example", host: "hub.test" }));
    expect(res.status).toBe(403);
    expect(h).not.toHaveBeenCalled();
  });

  it("403s Sec-Fetch-Site: cross-site", async () => {
    const h = vi.fn(async () => new Response("ok"));
    expect((await mutating(h)(post({ "sec-fetch-site": "cross-site" }))).status).toBe(403);
  });

  it("passes same-origin and header-less (non-browser) requests, forwarding ctx", async () => {
    const h = vi.fn(async (...args: [Request, { id: string }]) => (void args, new Response("ok")));
    const wrapped = mutating(h);
    expect((await wrapped(post({ origin: "http://hub.test", host: "hub.test" }), { id: "1" })).status).toBe(200);
    expect((await wrapped(post({}), { id: "2" })).status).toBe(200);
    expect(h).toHaveBeenLastCalledWith(expect.any(Request), { id: "2" });
  });
});

describe("CSRF coverage", () => {
  const root = join(process.cwd(), "src/app");
  const files = walk(root).map((f) => ({ rel: relative(root, f), src: readFileSync(f, "utf8") }));

  it("every mutating route is wrapped in mutating() or on the documented exempt list", () => {
    const missing = files
      .filter(({ rel, src }) => /^\s*export (async function|const) (POST|PUT|PATCH|DELETE)\b/m.test(src) && !EXEMPT.has(rel))
      .filter(({ src }) => !/export const (POST|PUT|PATCH|DELETE) = mutating\(/.test(src) || /export async function (POST|PUT|PATCH|DELETE)\b/.test(src))
      .map((f) => f.rel);
    expect(missing).toEqual([]);
  });

  it("exempt routes really are unwrapped and still exist", () => {
    for (const rel of EXEMPT) {
      const f = files.find((x) => x.rel === rel);
      expect(f, rel).toBeTruthy();
      expect(f!.src).not.toContain("mutating(");
    }
  });
});
