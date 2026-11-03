import { beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin } from "@/lib/db/store";
import { rotateIntegrationToken } from "@/lib/integrations/tokens";
import {
  clampTracesRetentionDays,
  getTracesRetentionDays,
  setTracesRetentionDays,
} from "@/lib/metrics/retention";
import {
  MAX_SPANS_PER_REQUEST,
  getTrace,
  ingestOtlpTraces,
  listRecentTraces,
  parseOtlpTracesJson,
  purgeOtelSpans,
} from "./traces";
import { POST as otlpTracesPost } from "@/app/v1/traces/route";

const TRACE_A = "5b8efff798038103d269b633813fc60c";
const TRACE_B = "0af7651916cd43dd8448eb211c80319c";
const BASE_NS = BigInt("1729600000000000000");

function ns(offsetMs: number): string {
  return (BASE_NS + BigInt(Math.round(offsetMs * 1_000_000))).toString();
}

type SpanIn = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number | string;
  status?: { code?: number | string; message?: string };
  startMs: number;
  endMs: number;
};

function exportOf(service: string | null, spans: SpanIn[]) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            ...(service
              ? [{ key: "service.name", value: { stringValue: service } }]
              : []),
            { key: "host.name", value: { stringValue: "web-1" } },
          ],
        },
        scopeSpans: [
          {
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              parentSpanId: s.parentSpanId ?? "",
              name: s.name,
              kind: s.kind ?? 2,
              startTimeUnixNano: ns(s.startMs),
              endTimeUnixNano: ns(s.endMs),
              attributes: [
                { key: "http.route", value: { stringValue: "/checkout" } },
                { key: "http.status_code", value: { intValue: "200" } },
              ],
              status: s.status ?? {},
            })),
          },
        ],
      },
    ],
  };
}

function sampleExport() {
  return exportOf("checkout", [
    {
      traceId: TRACE_A,
      spanId: "aaaaaaaaaaaaaaa1",
      name: "GET /checkout",
      kind: 2,
      startMs: 0,
      endMs: 120,
    },
    {
      traceId: TRACE_A,
      spanId: "aaaaaaaaaaaaaaa2",
      parentSpanId: "aaaaaaaaaaaaaaa1",
      name: "SELECT orders",
      kind: "SPAN_KIND_CLIENT",
      status: { code: "STATUS_CODE_ERROR", message: "timeout" },
      startMs: 10,
      endMs: 60.5,
    },
  ]);
}

async function makeOrg(email: string) {
  const { org } = await createOrgAndAdmin({
    orgName: `Org ${email}`,
    adminName: "Admin",
    email,
    password: "CorrectHorse1",
  });
  return org;
}

describe("otel traces parse", () => {
  it("parses ids, timing, kind and status in number and string forms", () => {
    const { spans, dropped } = parseOtlpTracesJson(sampleExport());
    expect(dropped).toBe(0);
    expect(spans).toHaveLength(2);
    const [root, child] = spans;
    expect(root.traceId).toBe(TRACE_A);
    expect(root.parentSpanId).toBeNull();
    expect(root.serviceName).toBe("checkout");
    expect(root.resourceHost).toBe("web-1");
    expect(root.kind).toBe("server");
    expect(root.statusCode).toBe("unset");
    expect(root.durationMs).toBeCloseTo(120, 6);
    expect(root.startAt.toISOString()).toBe("2024-10-22T12:26:40.000Z");
    expect(root.attributes["http.route"]).toBe("/checkout");
    expect(child.parentSpanId).toBe("aaaaaaaaaaaaaaa1");
    expect(child.kind).toBe("client");
    expect(child.statusCode).toBe("error");
    expect(child.statusMessage).toBe("timeout");
    expect(child.durationMs).toBeCloseTo(50.5, 6);
  });

  it("falls back to unknown_service and skips spans without ids", () => {
    const body = exportOf(null, [
      { traceId: TRACE_B, spanId: "bbbbbbbbbbbbbbb1", name: "op", startMs: 0, endMs: 1 },
      { traceId: "", spanId: "bbbbbbbbbbbbbbb2", name: "bad", startMs: 0, endMs: 1 },
    ]);
    const { spans } = parseOtlpTracesJson(body);
    expect(spans).toHaveLength(1);
    expect(spans[0].serviceName).toBe("unknown_service");
  });

  it("normalises base64-encoded ids to lowercase hex", () => {
    const b64Trace = Buffer.from(TRACE_B, "hex").toString("base64");
    const b64Span = Buffer.from("bbbbbbbbbbbbbbb1", "hex").toString("base64");
    const { spans } = parseOtlpTracesJson(
      exportOf("svc", [
        { traceId: b64Trace, spanId: b64Span, name: "op", startMs: 0, endMs: 1 },
      ]),
    );
    expect(spans[0].traceId).toBe(TRACE_B);
    expect(spans[0].spanId).toBe("bbbbbbbbbbbbbbb1");
  });

  it("caps spans per request and counts the dropped ones", () => {
    const many: SpanIn[] = Array.from(
      { length: MAX_SPANS_PER_REQUEST + 5 },
      (_, i) => ({
        traceId: TRACE_B,
        spanId: (i + 1).toString(16).padStart(16, "0"),
        name: "op",
        startMs: i,
        endMs: i + 1,
      }),
    );
    const { spans, dropped } = parseOtlpTracesJson(exportOf("svc", many));
    expect(spans).toHaveLength(MAX_SPANS_PER_REQUEST);
    expect(dropped).toBe(5);
  });
});

describe("otel traces ingest", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  it("stores spans idempotently and reads a trace back in start order", async () => {
    const org = await makeOrg("traces1@example.com");
    const first = await ingestOtlpTraces({ orgId: org.id, body: sampleExport() });
    expect(first.accepted).toBe(2);
    const again = await ingestOtlpTraces({ orgId: org.id, body: sampleExport() });
    expect(again.accepted).toBe(2);

    const db = await getDb();
    const count = await db.query<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM otel_spans WHERE org_id = $1`,
      [org.id],
    );
    expect(Number(count.rows[0].n)).toBe(2);

    const trace = await getTrace(org.id, TRACE_A);
    expect(trace.map((s) => s.span_id)).toEqual([
      "aaaaaaaaaaaaaaa1",
      "aaaaaaaaaaaaaaa2",
    ]);
    expect(trace[1].status_code).toBe("error");

    const other = await makeOrg("traces1b@example.com");
    expect(await getTrace(other.id, TRACE_A)).toEqual([]);
  });

  it("lists recent traces with root, span count, error flag and service filter", async () => {
    const org = await makeOrg("traces2@example.com");
    await ingestOtlpTraces({ orgId: org.id, body: sampleExport() });
    await ingestOtlpTraces({
      orgId: org.id,
      body: exportOf("billing", [
        { traceId: TRACE_B, spanId: "bbbbbbbbbbbbbbb1", name: "POST /pay", startMs: 500, endMs: 530 },
      ]),
    });

    const all = await listRecentTraces(org.id);
    expect(all.map((t) => t.trace_id)).toEqual([TRACE_B, TRACE_A]);
    const a = all.find((t) => t.trace_id === TRACE_A)!;
    expect(a.root_name).toBe("GET /checkout");
    expect(a.root_service).toBe("checkout");
    expect(a.span_count).toBe(2);
    expect(a.error_count).toBe(1);
    expect(a.duration_ms).toBeCloseTo(120, 3);

    const billing = await listRecentTraces(org.id, { service: "billing" });
    expect(billing.map((t) => t.trace_id)).toEqual([TRACE_B]);
  });

  it("purges spans older than tracesRetentionDays", async () => {
    const org = await makeOrg("traces3@example.com");
    expect(await getTracesRetentionDays(org.id)).toBe(7);
    await ingestOtlpTraces({ orgId: org.id, body: sampleExport() });
    const start = Date.parse("2024-10-22T12:26:40.000Z");

    expect(await purgeOtelSpans(org.id, start + 6 * 86_400_000)).toBe(0);
    expect(await setTracesRetentionDays(org.id, 1)).toBe(1);
    expect(await purgeOtelSpans(org.id, start + 2 * 86_400_000)).toBe(2);
  });

  it("clamps traces retention to 1–60 days", () => {
    expect(clampTracesRetentionDays(0)).toBe(1);
    expect(clampTracesRetentionDays(400)).toBe(60);
    expect(clampTracesRetentionDays(Number.NaN)).toBe(7);
  });

  it("route: 401 without token, 415 for protobuf, 200 with partialSuccess", async () => {
    const org = await makeOrg("traces4@example.com");
    const { token } = await rotateIntegrationToken({
      orgId: org.id,
      kind: "otel_ingest",
    });
    const post = (headers: Record<string, string>) =>
      otlpTracesPost(
        new Request("http://localhost/v1/traces", {
          method: "POST",
          headers,
          body: JSON.stringify(sampleExport()),
        }),
      );

    expect((await post({ "content-type": "application/json" })).status).toBe(401);
    expect(
      (
        await post({
          "content-type": "application/x-protobuf",
          authorization: `Bearer ${token}`,
        })
      ).status,
    ).toBe(415);
    const ok = await post({
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    });
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as {
      accepted: number;
      partialSuccess: Record<string, unknown>;
    };
    expect(json.accepted).toBe(2);
    expect(json.partialSuccess).toEqual({});
  });
});
