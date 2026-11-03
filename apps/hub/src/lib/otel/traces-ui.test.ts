import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin } from "@/lib/db/store";
import {
  buildWaterfall,
  formatMs,
  formatRate,
  ingestOtlpTraces,
  listOperations,
  listRecentTraces,
  listTraceServices,
  parseWindow,
  type SpanRow,
} from "./traces";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const MIN = 60_000;

function hex(n: number, len: number): string {
  return n.toString(16).padStart(len, "0");
}

type In = {
  trace: number;
  span: number;
  parent?: number;
  service: string;
  name: string;
  kind: number;
  error?: boolean;
  atMs: number; // absolute epoch ms
  durMs: number;
};

function body(spans: In[]) {
  return {
    resourceSpans: spans.map((s) => ({
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: s.service } }],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: hex(s.trace, 32),
              spanId: hex(s.span, 16),
              parentSpanId: s.parent ? hex(s.parent, 16) : "",
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: (BigInt(s.atMs) * BigInt(1_000_000)).toString(),
              endTimeUnixNano: (
                BigInt(s.atMs) * BigInt(1_000_000) +
                BigInt(Math.round(s.durMs * 1_000_000))
              ).toString(),
              status: s.error ? { code: 2, message: "boom" } : {},
            },
          ],
        },
      ],
    })),
  };
}

const SERVER = 2;
const CLIENT = 3;
const CONSUMER = 5;

function fixture(): In[] {
  const t0 = NOW - 30 * MIN;
  return [
    { trace: 1, span: 11, service: "api", name: "GET /a", kind: SERVER, atMs: t0, durMs: 10 },
    // client child: must not count toward api RED
    { trace: 1, span: 12, parent: 11, service: "api", name: "SELECT", kind: CLIENT, atMs: t0 + 2, durMs: 5 },
    { trace: 2, span: 21, service: "api", name: "GET /a", kind: SERVER, atMs: t0 + MIN, durMs: 20 },
    { trace: 3, span: 31, service: "api", name: "GET /a", kind: SERVER, atMs: t0 + 2 * MIN, durMs: 30 },
    { trace: 4, span: 41, service: "api", name: "POST /b", kind: SERVER, error: true, atMs: t0 + 3 * MIN, durMs: 40 },
    { trace: 5, span: 51, service: "worker", name: "consume jobs", kind: CONSUMER, atMs: t0 + 4 * MIN, durMs: 5 },
    // outside a 1h window
    { trace: 6, span: 61, service: "api", name: "GET /a", kind: SERVER, atMs: NOW - 2 * 60 * MIN, durMs: 999 },
  ];
}

describe("trace UI helpers (pure)", () => {
  it("parseWindow defaults to 1h and accepts known keys only", () => {
    expect(parseWindow(undefined)).toEqual({ key: "1h", ms: 60 * MIN });
    expect(parseWindow("15m")).toEqual({ key: "15m", ms: 15 * MIN });
    expect(parseWindow("24h")).toEqual({ key: "24h", ms: 24 * 60 * MIN });
    expect(parseWindow("bogus")).toEqual({ key: "1h", ms: 60 * MIN });
  });

  it("formatMs picks µs / ms / s", () => {
    expect(formatMs(0.5)).toBe("500µs");
    expect(formatMs(2.5)).toBe("2.50ms");
    expect(formatMs(12.34)).toBe("12.3ms");
    expect(formatMs(250)).toBe("250ms");
    expect(formatMs(1500)).toBe("1.50s");
    expect(formatMs(null)).toBe("—");
  });

  it("formatRate scales precision with magnitude", () => {
    expect(formatRate(4 / 60)).toBe("0.07/min");
    expect(formatRate(12.34)).toBe("12.3/min");
    expect(formatRate(250.4)).toBe("250/min");
  });

  function row(
    id: string,
    parent: string | null,
    startMs: number,
    dur: number,
  ): SpanRow {
    return {
      trace_id: hex(9, 32),
      span_id: id,
      parent_span_id: parent,
      service_name: "svc",
      name: id,
      kind: "internal",
      status_code: "unset",
      status_message: null,
      start_at: new Date(NOW + startMs).toISOString(),
      duration_ms: dur,
      resource_host: null,
      agent_id: null,
      attributes: {},
    };
  }

  it("buildWaterfall orders depth-first by start, computes offsets and flags orphans", () => {
    const rows = buildWaterfall([
      row("a", null, 0, 100),
      row("b", "a", 10, 50),
      row("c", "a", 5, 15),
      row("d", "b", 15, 10),
      row("e", "missing", 90, 10),
    ]);
    expect(rows.map((r) => [r.span.span_id, r.depth, r.orphan])).toEqual([
      ["a", 0, false],
      ["c", 1, false],
      ["b", 1, false],
      ["d", 2, false],
      ["e", 0, true],
    ]);
    const byId = Object.fromEntries(rows.map((r) => [r.span.span_id, r]));
    expect(byId.a.offsetPct).toBeCloseTo(0);
    expect(byId.a.widthPct).toBeCloseTo(100);
    expect(byId.c.offsetPct).toBeCloseTo(5);
    expect(byId.b.widthPct).toBeCloseTo(50);
    expect(byId.d.offsetPct).toBeCloseTo(15);
    expect(byId.e.offsetPct).toBeCloseTo(90);
  });

  it("buildWaterfall keeps tiny and zero-duration spans visible", () => {
    const zero = buildWaterfall([row("z", null, 0, 0)]);
    expect(zero[0].offsetPct).toBe(0);
    expect(zero[0].widthPct).toBe(100);
    const tiny = buildWaterfall([row("a", null, 0, 1000), row("t", "a", 500, 0.001)]);
    expect(tiny[1].widthPct).toBe(0.5);
    expect(tiny[1].offsetPct + tiny[1].widthPct).toBeLessThanOrEqual(100);
    expect(buildWaterfall([])).toEqual([]);
  });
});

describe("trace UI queries", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  async function seeded() {
    const { org } = await createOrgAndAdmin({
      orgName: `Org ${Math.random()}`,
      adminName: "Admin",
      email: `ui${Math.random().toString(36).slice(2)}@example.com`,
      password: "CorrectHorse1",
    });
    await ingestOtlpTraces({ orgId: org.id, body: body(fixture()) });
    return org.id;
  }

  it("listTraceServices computes RED from entry spans inside the window", async () => {
    const orgId = await seeded();
    const since = new Date(NOW - 60 * MIN);
    const services = await listTraceServices(orgId, { since, now: new Date(NOW) });
    expect(services.map((s) => s.service)).toEqual(["api", "worker"]);
    const api = services[0];
    expect(api.count).toBe(4);
    expect(api.ratePerMin).toBeCloseTo(4 / 60, 6);
    expect(api.errorPct).toBeCloseTo(25, 6);
    expect(api.p50Ms).toBeCloseTo(25, 3);
    expect(api.p95Ms).toBeCloseTo(38.5, 3);
    expect(api.lastSeen).toBe(new Date(NOW - 27 * MIN).toISOString());
    expect(services[1].count).toBe(1);
  });

  it("listOperations groups entry spans by name, busiest first", async () => {
    const orgId = await seeded();
    const ops = await listOperations(orgId, "api", {
      since: new Date(NOW - 60 * MIN),
      now: new Date(NOW),
    });
    expect(ops.map((o) => [o.name, o.count, o.errorPct])).toEqual([
      ["GET /a", 3, 0],
      ["POST /b", 1, 100],
    ]);
    expect(ops[0].p50Ms).toBeCloseTo(20, 3);
  });

  it("listRecentTraces filters by errorsOnly, minDurationMs and operation", async () => {
    const orgId = await seeded();
    const since = new Date(NOW - 60 * MIN);
    const ids = (rows: { trace_id: string }[]) =>
      rows.map((r) => parseInt(r.trace_id, 16));

    expect(ids(await listRecentTraces(orgId, { since, errorsOnly: true }))).toEqual([4]);
    expect(ids(await listRecentTraces(orgId, { since, minDurationMs: 35 }))).toEqual([4]);
    expect(
      ids(await listRecentTraces(orgId, { since, service: "api", operation: "GET /a" })),
    ).toEqual([3, 2, 1]);
    expect(ids(await listRecentTraces(orgId, { since }))).toEqual([5, 4, 3, 2, 1]);
  });
});
