import { describe, expect, it, vi } from "vitest";

// These tests stub global fetch with fake hosts; SSRF blocking is covered in http-guard/ and channels.ssrf.test.ts.
vi.mock("@/lib/http-guard/safe-fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/http-guard/safe-fetch")>()),
  guardedFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));
import { DiscordChannel, SlackChannel, SmsChannel, createChannel } from "./channels";
import {
  channelWantedByUsers,
  dispatchAlert,
  evaluateRule,
} from "./engine";
import type { NotificationPrefsRow } from "@/lib/db/types";

function prefs(
  overrides: Partial<NotificationPrefsRow> = {},
): NotificationPrefsRow {
  return {
    user_id: "usr_1",
    org_id: "org_1",
    notify_smtp: true,
    notify_slack: true,
    notify_discord: true,
    notify_sms: true,
    sms_phone: null,
    quiet_hours_enabled: false,
    quiet_start: "22:00",
    quiet_end: "07:00",
    timezone: "UTC",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("alert threshold engine", () => {
  it("evaluates operators", () => {
    const rule = {
      metric: "agent_offline_minutes",
      operator: "gte" as const,
      threshold: 5,
      warn_threshold: null,
      alarm_threshold: 5,
      enabled: true,
    };
    expect(evaluateRule(rule, { metric: "agent_offline_minutes", value: 5 })).toBe(
      true,
    );
    expect(evaluateRule(rule, { metric: "agent_offline_minutes", value: 4 })).toBe(
      false,
    );
    expect(
      evaluateRule(
        { ...rule, enabled: false },
        { metric: "agent_offline_minutes", value: 9 },
      ),
    ).toBe(false);
  });

  it("matches disk_percent path metrics and dual bands", async () => {
    const { evaluateRuleBand, ruleMatchesMetric } = await import("./engine");
    expect(ruleMatchesMetric("disk_percent", "disk_percent:/var")).toBe(true);
    expect(ruleMatchesMetric("disk_percent", "cpu_percent")).toBe(false);

    const diskRule = {
      metric: "disk_percent",
      operator: "gte" as const,
      threshold: 98,
      warn_threshold: 90,
      alarm_threshold: 98,
      enabled: true,
    };
    expect(evaluateRuleBand(diskRule, { metric: "disk_percent:/var", value: 91 })).toBe(
      "yellow",
    );
    expect(evaluateRuleBand(diskRule, { metric: "disk_percent:/var", value: 98 })).toBe(
      "red",
    );
    expect(evaluateRule(diskRule, { metric: "disk_percent:/var", value: 98 })).toBe(
      true,
    );
  });

  it("creates a real SMS channel (Twilio-compatible)", () => {
    const sms = createChannel("sms", {
      accountSid: "AC123",
      authToken: "tok",
      from: "+1000",
      to: "+2000",
    });
    expect(sms).toBeInstanceOf(SmsChannel);
    expect(sms.kind).toBe("sms");
  });

  it("posts Slack and Discord webhooks", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const slack = new SlackChannel({ url: "https://hooks.example/slack" });
    const discord = new DiscordChannel({ url: "https://hooks.example/discord" });
    expect((await slack.send({ subject: "S", message: "M" })).ok).toBe(true);
    expect((await discord.send({ subject: "S", message: "M" })).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it("dispatches SMS when enabled with Twilio-compatible config", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await dispatchAlert(
      [
        {
          id: "1",
          org_id: "o",
          kind: "slack",
          enabled: true,
          config_json: JSON.stringify({ url: "https://hooks.example/slack" }),
          created_at: new Date().toISOString(),
        },
        {
          id: "2",
          org_id: "o",
          kind: "sms",
          enabled: true,
          config_json: JSON.stringify({
            accountSid: "ACtest",
            authToken: "tok",
            from: "+1000",
            to: "+2000",
          }),
          created_at: new Date().toISOString(),
        },
      ],
      { subject: "Agent offline", message: "edge-01 silent" },
    );

    expect(results.find((r) => r.channel === "slack")?.ok).toBe(true);
    expect(results.find((r) => r.channel === "sms")?.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("honors per-user channel preferences", () => {
    expect(channelWantedByUsers("sms", [prefs({ notify_sms: false })])).toBe(
      false,
    );
    expect(channelWantedByUsers("sms", [prefs({ notify_sms: true })])).toBe(
      true,
    );
    expect(channelWantedByUsers("sms", [])).toBe(true);
  });

  it("suppresses during quiet hours for non-critical alerts", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await dispatchAlert(
      [
        {
          id: "1",
          org_id: "o",
          kind: "slack",
          enabled: true,
          config_json: JSON.stringify({ url: "https://hooks.example/slack" }),
          created_at: new Date().toISOString(),
        },
      ],
      { subject: "Agent offline", message: "edge-01 silent", severity: "warning" },
      {
        prefs: [
          prefs({
            quiet_hours_enabled: true,
            quiet_start: "22:00",
            quiet_end: "07:00",
            timezone: "UTC",
          }),
        ],
        now: new Date("2026-01-15T03:00:00.000Z"),
      },
    );

    expect(results).toEqual([
      {
        ok: true,
        channel: "quiet_hours",
        detail: "suppressed during quiet hours",
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
