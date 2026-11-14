import { afterEach, describe, expect, it, vi } from "vitest";

// Stub the SSRF-guarded fetch with the global one; blocking itself is covered in channels.ssrf.test.ts.
vi.mock("@/lib/http-guard/safe-fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/http-guard/safe-fetch")>()),
  guardedFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));
import { redactConfig } from "@/lib/backup/export";
import {
  NtfyChannel,
  PagerDutyChannel,
  PushoverChannel,
  TelegramChannel,
  createChannel,
  validateChannelConfig,
  type AlertPayload,
} from "./channels";

const critical: AlertPayload = {
  subject: "High CPU on edge-01",
  message: "cpu_percent is 99%",
  severity: "critical",
  hostname: "edge-01",
  deepLink: "https://hub.example/dashboard/alerts?id=evt_1",
  fields: [{ label: "Host", value: "edge-01" }],
};
const warning: AlertPayload = { ...critical, severity: "warning" };
const recovery: AlertPayload = { ...critical, kind: "recovery", severity: "info", message: "back to normal" };

function stub(res: () => Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => res());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const bodyOf = (m: ReturnType<typeof stub>) => String(m.mock.calls[0][1]?.body);

afterEach(() => vi.unstubAllGlobals());

describe("ntfy", () => {
  it("publishes JSON with priority, tags and click link; bearer token when set", async () => {
    const f = stub(() => new Response("{}", { status: 200 }));
    const r = await new NtfyChannel({ serverUrl: "https://ntfy.example.com/", topic: "heimdall", token: "tk_1" }).send(critical);
    expect(r).toMatchObject({ ok: true, channel: "ntfy" });
    expect(String(f.mock.calls[0][0])).toBe("https://ntfy.example.com/");
    const init = f.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tk_1");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ topic: "heimdall", priority: 5, click: critical.deepLink });
    expect(body.title).toContain("High CPU on edge-01");
    expect(body.tags).toContain("rotating_light");
  });

  it("maps severities and recovery", async () => {
    const f = stub(() => new Response("{}", { status: 200 }));
    const c = new NtfyChannel({ topic: "t" });
    await c.send(warning);
    await c.send(recovery);
    expect(String(f.mock.calls[0][0])).toBe("https://ntfy.sh/");
    expect(JSON.parse(String(f.mock.calls[0][1]?.body)).priority).toBe(3);
    const rec = JSON.parse(String(f.mock.calls[1][1]?.body));
    expect(rec.priority).toBe(2);
    expect(rec.tags).toContain("white_check_mark");
    expect(rec.title).toMatch(/Recovered/);
  });

  it("reports a failure response", async () => {
    stub(() => new Response("forbidden", { status: 403 }));
    const r = await new NtfyChannel({ topic: "t" }).send(critical);
    expect(r).toMatchObject({ ok: false, channel: "ntfy" });
    expect(r.detail).toMatch(/403/);
  });

  it("requires a topic", async () => {
    const r = await new NtfyChannel({ topic: " " }).send(critical);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/topic/);
  });
});

describe("pushover", () => {
  it("posts a form with token, user, priority and url", async () => {
    const f = stub(() => new Response(JSON.stringify({ status: 1, request: "r" }), { status: 200 }));
    const r = await new PushoverChannel({ appToken: "app", userKey: "usr" }).send(critical);
    expect(r).toMatchObject({ ok: true, channel: "pushover" });
    expect(String(f.mock.calls[0][0])).toBe("https://api.pushover.net/1/messages.json");
    const form = new URLSearchParams(bodyOf(f));
    expect(form.get("token")).toBe("app");
    expect(form.get("user")).toBe("usr");
    expect(form.get("priority")).toBe("1");
    expect(form.get("url")).toBe(critical.deepLink);
    expect(form.get("title")).toContain("Critical");
  });

  it("maps warning to 0 and recovery to -1", async () => {
    const f = stub(() => new Response(JSON.stringify({ status: 1 }), { status: 200 }));
    const c = new PushoverChannel({ appToken: "a", userKey: "u", device: "phone" });
    await c.send(warning);
    await c.send(recovery);
    expect(new URLSearchParams(String(f.mock.calls[0][1]?.body)).get("priority")).toBe("0");
    expect(new URLSearchParams(String(f.mock.calls[0][1]?.body)).get("device")).toBe("phone");
    expect(new URLSearchParams(String(f.mock.calls[1][1]?.body)).get("priority")).toBe("-1");
  });

  it("reports an API rejection (4xx with errors)", async () => {
    stub(() => new Response(JSON.stringify({ status: 0, errors: ["application token is invalid"] }), { status: 400 }));
    const r = await new PushoverChannel({ appToken: "bad", userKey: "u" }).send(critical);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/400/);
    expect(r.detail).toMatch(/invalid/);
  });

  it("treats a 200 with status 0 as a failure", async () => {
    stub(() => new Response(JSON.stringify({ status: 0, errors: ["nope"] }), { status: 200 }));
    expect((await new PushoverChannel({ appToken: "a", userKey: "u" }).send(critical)).ok).toBe(false);
  });
});

describe("telegram", () => {
  it("calls sendMessage with chat id and text, no token in the result", async () => {
    const f = stub(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const r = await new TelegramChannel({ botToken: "123:ABC", chatId: "-1001" }).send(critical);
    expect(r).toMatchObject({ ok: true, channel: "telegram" });
    expect(String(f.mock.calls[0][0])).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    const body = JSON.parse(String(f.mock.calls[0][1]?.body));
    expect(body.chat_id).toBe("-1001");
    expect(body.text).toContain("High CPU on edge-01");
    expect(body.text).toContain(critical.deepLink);
    expect(JSON.stringify(r)).not.toContain("123:ABC");
  });

  it("marks recovery with a check mark", async () => {
    const f = stub(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await new TelegramChannel({ botToken: "1:a", chatId: "1" }).send(recovery);
    expect(JSON.parse(bodyOf(f)).text).toMatch(/✅/);
  });

  it("reports a failure without leaking the bot token", async () => {
    stub(() => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }));
    const r = await new TelegramChannel({ botToken: "123:SECRET", chatId: "1" }).send(critical);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/401/);
    expect(r.detail).toMatch(/Unauthorized/);
    expect(r.detail).not.toContain("SECRET");
  });
});

describe("pagerduty", () => {
  it("triggers with severity, summary, links and a stable dedup key", async () => {
    const f = stub(() => new Response(JSON.stringify({ status: "success", dedup_key: "k" }), { status: 202 }));
    const r = await new PagerDutyChannel({ routingKey: "rk" }).send({ ...critical, dedupKey: "fp-123" });
    expect(r).toMatchObject({ ok: true, channel: "pagerduty" });
    expect(String(f.mock.calls[0][0])).toBe("https://events.pagerduty.com/v2/enqueue");
    const body = JSON.parse(bodyOf(f));
    expect(body).toMatchObject({
      routing_key: "rk",
      event_action: "trigger",
      dedup_key: "fp-123",
      payload: { severity: "critical", source: "edge-01" },
      links: [{ href: critical.deepLink }],
    });
    expect(body.payload.summary).toContain("High CPU on edge-01");
  });

  it("maps warning and resolves on recovery with the same derived dedup key", async () => {
    const f = stub(() => new Response("{}", { status: 202 }));
    const c = new PagerDutyChannel({ routingKey: "rk" });
    await c.send(warning);
    await c.send(recovery);
    const trig = JSON.parse(String(f.mock.calls[0][1]?.body));
    const res = JSON.parse(String(f.mock.calls[1][1]?.body));
    expect(trig.payload.severity).toBe("warning");
    expect(res.event_action).toBe("resolve");
    expect(res.dedup_key).toBe(trig.dedup_key);
  });

  it("reports a failure response", async () => {
    stub(() => new Response(JSON.stringify({ status: "invalid event", message: "Event object is invalid" }), { status: 400 }));
    const r = await new PagerDutyChannel({ routingKey: "bad" }).send(critical);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/400/);
  });
});

describe("factory and validation", () => {
  it("createChannel builds each new kind", () => {
    expect(createChannel("ntfy", { topic: "t" }).kind).toBe("ntfy");
    expect(createChannel("pushover", { appToken: "a", userKey: "u" }).kind).toBe("pushover");
    expect(createChannel("telegram", { botToken: "1:a", chatId: "1" }).kind).toBe("telegram");
    expect(createChannel("pagerduty", { routingKey: "r" }).kind).toBe("pagerduty");
  });

  it("validateChannelConfig flags missing fields", () => {
    expect(validateChannelConfig("ntfy", { topic: "ok" })).toBeNull();
    expect(validateChannelConfig("ntfy", { topic: "has space" })).toMatch(/topic/);
    expect(validateChannelConfig("pushover", { appToken: "a" })).toMatch(/userKey/);
    expect(validateChannelConfig("telegram", { botToken: "nocolon", chatId: "1" })).toMatch(/botToken/);
    expect(validateChannelConfig("pagerduty", {})).toMatch(/routingKey/);
  });

  it("backup redaction hides the new channel secrets", () => {
    const out = redactConfig(
      { appToken: "a", userKey: "u", botToken: "1:a", routingKey: "r", token: "t", topic: "t", chatId: "1" },
      false,
    );
    expect(out).toMatchObject({
      appToken: "[redacted]",
      userKey: "[redacted]",
      botToken: "[redacted]",
      routingKey: "[redacted]",
      token: "[redacted]",
      topic: "t",
    });
  });
});
