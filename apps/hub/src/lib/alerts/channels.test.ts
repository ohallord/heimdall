import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// These tests stub global fetch with fake hosts; SSRF blocking is covered in http-guard/ and channels.ssrf.test.ts.
vi.mock("@/lib/http-guard/safe-fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/http-guard/safe-fetch")>()),
  guardedFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));
import {
  DiscordChannel,
  SlackChannel,
  SmsChannel,
  createChannel,
} from "./channels";

function fixture(name: string): string {
  return readFileSync(
    path.join(__dirname, "fixtures", name),
    "utf8",
  );
}

describe("channel adapters with recorded HTTP fixtures", () => {
  it("sends Twilio-compatible SMS using Messages.json fixture", async () => {
    const body = fixture("twilio-messages-201.json");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain(
        "/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages.json",
      );
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        "content-type": "application/x-www-form-urlencoded",
      });
      const auth = (init?.headers as Record<string, string>).authorization;
      expect(auth).toMatch(/^Basic /);
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("From")).toBe("+15017122661");
      expect(form.get("To")).toBe("+15558675310");
      expect(form.get("Body")).toContain("Agent offline");
      return new Response(body, {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const sms = new SmsChannel({
      accountSid: "ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      authToken: "test-token",
      from: "+15017122661",
      to: "+15558675310",
    });
    const result = await sms.send({
      subject: "Agent offline",
      message: "edge-01 silent",
    });
    expect(result.ok).toBe(true);
    expect(result.channel).toBe("sms");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("surfaces Twilio auth failures from 401 fixture", async () => {
    const body = fixture("twilio-messages-401.json");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 401 })),
    );

    const sms = createChannel("sms", {
      accountSid: "AC123",
      authToken: "bad",
      from: "+1000",
      to: "+2000",
    }) as SmsChannel;
    const result = await sms.send({ subject: "x", message: "y" });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/401/);

    vi.unstubAllGlobals();
  });

  it("posts Slack webhook using fixture response", async () => {
    const body = fixture("slack-webhook-ok.json");
    let posted: string | undefined;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posted = String(init?.body ?? "");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const slack = new SlackChannel({ url: "https://hooks.example/slack" });
    expect(
      (
        await slack.send({
          subject: "S",
          message: "M",
          fields: [{ label: "Host", value: "edge-01" }],
          deepLink: "/dashboard/alerts?id=evt_1",
        })
      ).ok,
    ).toBe(true);
    const msg = JSON.parse(posted ?? "{}");
    expect(msg.text).toContain("S");
    const attachment = msg.attachments[0];
    expect(attachment.color).toMatch(/^#[0-9a-f]{6}$/i);
    const blob = JSON.stringify(attachment.blocks);
    expect(blob).toContain("*Host*\\nedge-01");
    expect(blob).toContain("View: /dashboard/alerts?id=evt_1");

    vi.unstubAllGlobals();
  });

  it("posts Discord webhook using fixture response", async () => {
    const body = fixture("discord-webhook-ok.json");
    const fetchMock = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const discord = new DiscordChannel({ url: "https://hooks.example/discord" });
    expect((await discord.send({ subject: "S", message: "M" })).ok).toBe(true);

    vi.unstubAllGlobals();
  });

  it("rejects incomplete SMS config without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await new SmsChannel({
      accountSid: "",
      authToken: "",
      from: "",
      to: "",
    }).send({ subject: "x", message: "y" });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
