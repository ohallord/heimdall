import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { assertPublicUrl, BlockedHostError, guardedFetch } from "@/lib/http-guard/safe-fetch";
import {
  alertTone,
  formatAlertBody,
  formatAlertHtml,
  formatDiscordMessage,
  formatSlackMessage,
  formatSmsBody,
  formatSubject,
  isAbsoluteUrl,
} from "./format";

export type AlertPayload = {
  subject: string;
  message: string;
  severity?: "info" | "warning" | "critical";
  /** "recovery" renders as a green "Recovered" notification. Default "alert". */
  kind?: "alert" | "recovery";
  fields?: { label: string; value: string }[];
  deepLink?: string;
  hostname?: string;
  /** Stable incident key (PagerDuty dedup_key). Defaults to a hash of hostname + subject. */
  dedupKey?: string;
};

export type ChannelSendResult = {
  ok: boolean;
  channel: string;
  detail?: string;
};

export interface AlertChannel {
  kind: string;
  send(payload: AlertPayload): Promise<ChannelSendResult>;
}

export type SmtpConfig = {
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string;
};

export type WebhookConfig = {
  url: string;
};

/** Twilio-compatible SMS (Twilio, Telnyx-compatible gateways, etc.). */
export type SmsConfig = {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  /** Override API root; default https://api.twilio.com */
  apiBaseUrl?: string;
};

/** http:// stand-in URL so SMTP hosts go through the same assertPublicUrl check as webhooks. */
export function smtpProbeUrl(host: string, port?: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${h}${port ? `:${port}` : ""}/`;
}

export class SmtpChannel implements AlertChannel {
  kind = "smtp";
  constructor(private readonly config: SmtpConfig) {}

  async send(payload: AlertPayload): Promise<ChannelSendResult> {
    // Same SSRF rule as webhooks: resolve once, refuse private targets unless allowlisted,
    // and connect to the validated IP (TLS still verifies the configured hostname).
    const { addresses } = await assertPublicUrl(smtpProbeUrl(this.config.host, this.config.port));
    const transport = nodemailer.createTransport({
      host: addresses[0],
      port: this.config.port,
      secure: this.config.secure ?? false,
      tls: { servername: this.config.host },
      connectionTimeout: 3_000,
      greetingTimeout: 3_000,
      socketTimeout: 5_000,
      auth:
        this.config.user && this.config.pass
          ? { user: this.config.user, pass: this.config.pass }
          : undefined,
    });

    try {
      await transport.sendMail({
        from: this.config.from,
        to: this.config.to,
        subject: formatSubject(payload),
        text: formatAlertBody(payload),
        html: formatAlertHtml(payload),
      });
      return { ok: true, channel: this.kind };
    } finally {
      transport.close();
    }
  }
}

/** Outbound HTTP for alert channels: SSRF-guarded (HEIMDALL_ALLOW_PRIVATE_HOSTS), 5s timeout, size-capped. */
async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  ms = 5_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await guardedFetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Run a send; a blocked destination is a normal failed result (surfaced to the admin), not a crash. */
async function guardSend(kind: string, run: () => Promise<ChannelSendResult>): Promise<ChannelSendResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof BlockedHostError) {
      return { ok: false, channel: kind, detail: err.message };
    }
    throw err;
  }
}

export class SlackChannel implements AlertChannel {
  kind = "slack";
  constructor(private readonly config: WebhookConfig) {}

  send(payload: AlertPayload): Promise<ChannelSendResult> {
    return guardSend(this.kind, () => this.sendUnsafe(payload));
  }

  private async sendUnsafe(payload: AlertPayload): Promise<ChannelSendResult> {
    const res = await fetchWithTimeout(this.config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formatSlackMessage(payload)),
    });
    if (!res.ok) {
      return {
        ok: false,
        channel: this.kind,
        detail: `status ${res.status}`,
      };
    }
    return { ok: true, channel: this.kind };
  }
}

export class DiscordChannel implements AlertChannel {
  kind = "discord";
  constructor(private readonly config: WebhookConfig) {}

  send(payload: AlertPayload): Promise<ChannelSendResult> {
    return guardSend(this.kind, () => this.sendUnsafe(payload));
  }

  private async sendUnsafe(payload: AlertPayload): Promise<ChannelSendResult> {
    const res = await fetchWithTimeout(this.config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formatDiscordMessage(payload)),
    });
    if (!res.ok) {
      return {
        ok: false,
        channel: this.kind,
        detail: `status ${res.status}`,
      };
    }
    return { ok: true, channel: this.kind };
  }
}

/**
 * Twilio Messages API compatible adapter.
 * POST /2010-04-01/Accounts/{AccountSid}/Messages.json
 */
export class SmsChannel implements AlertChannel {
  kind = "sms";
  constructor(private readonly config: SmsConfig) {}

  send(payload: AlertPayload): Promise<ChannelSendResult> {
    return guardSend(this.kind, () => this.sendUnsafe(payload));
  }

  private async sendUnsafe(payload: AlertPayload): Promise<ChannelSendResult> {
    const sid = this.config.accountSid?.trim();
    const token = this.config.authToken?.trim();
    const from = this.config.from?.trim();
    const to = this.config.to?.trim();
    if (!sid || !token || !from || !to) {
      return {
        ok: false,
        channel: this.kind,
        detail: "sms config requires accountSid, authToken, from, and to",
      };
    }

    const base = (this.config.apiBaseUrl ?? "https://api.twilio.com").replace(
      /\/$/,
      "",
    );
    const url = `${base}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
    const body = new URLSearchParams({
      From: from,
      To: to,
      Body: formatSmsBody(payload),
    });
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");

    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        channel: this.kind,
        detail: `status ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    return { ok: true, channel: this.kind, detail: `status ${res.status}` };
  }
}

/** ntfy.sh or self-hosted ntfy. Publishes JSON to the server root. */
export type NtfyConfig = { serverUrl?: string; topic: string; token?: string };
/** Pushover application token + user (or group) key. */
export type PushoverConfig = { appToken: string; userKey: string; device?: string; apiBaseUrl?: string };
/** Telegram bot token (`123456:ABC…`) and the chat id to post into. */
export type TelegramConfig = { botToken: string; chatId: string | number; apiBaseUrl?: string };
/** PagerDuty Events API v2 integration (routing) key. */
export type PagerDutyConfig = { routingKey: string; apiBaseUrl?: string };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** Returns a human-readable problem with a channel config, or null when it is usable. */
export function validateChannelConfig(kind: string, config: Record<string, unknown>): string | null {
  switch (kind) {
    case "ntfy":
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(str(config.topic))) return "ntfy topic must be 1-64 letters, digits, - or _";
      return null;
    case "pushover":
      if (!str(config.appToken)) return "pushover appToken is required";
      if (!str(config.userKey)) return "pushover userKey is required";
      return null;
    case "telegram":
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(str(config.botToken))) return "telegram botToken must look like 123456:ABC-DEF";
      if (!str(config.chatId)) return "telegram chatId is required";
      return null;
    case "pagerduty":
      if (!str(config.routingKey)) return "pagerduty routingKey is required";
      return null;
    default:
      return null;
  }
}

function notifyBody(payload: AlertPayload): string {
  const lines: string[] = [];
  if (payload.message) lines.push(payload.message);
  for (const f of payload.fields ?? []) lines.push(`${f.label}: ${f.value}`);
  return lines.join("\n");
}

async function failDetail(res: Response, pick?: (json: Record<string, unknown>) => string | undefined): Promise<string> {
  const text = await res.text().catch(() => "");
  let extra = "";
  try {
    extra = pick?.(JSON.parse(text) as Record<string, unknown>) ?? "";
  } catch {
    extra = text;
  }
  return `status ${res.status}${extra ? `: ${extra.slice(0, 200)}` : ""}`;
}

export class NtfyChannel implements AlertChannel {
  kind = "ntfy";
  constructor(private readonly config: NtfyConfig) {}

  send(payload: AlertPayload): Promise<ChannelSendResult> {
    return guardSend(this.kind, () => this.sendUnsafe(payload));
  }

  private async sendUnsafe(payload: AlertPayload): Promise<ChannelSendResult> {
    const problem = validateChannelConfig("ntfy", this.config as unknown as Record<string, unknown>);
    if (problem) return { ok: false, channel: this.kind, detail: problem };
    const server = (this.config.serverUrl?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
    const tone = alertTone(payload);
    // ntfy priorities: 5 max, 3 default, 2 low.
    const priority = payload.kind === "recovery" ? 2 : payload.severity === "critical" ? 5 : payload.severity === "info" ? 2 : 3;
    const tags =
      payload.kind === "recovery"
        ? ["white_check_mark"]
        : payload.severity === "critical"
          ? ["rotating_light"]
          : payload.severity === "info"
            ? ["information_source"]
            : ["warning"];
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.token?.trim()) headers.authorization = `Bearer ${this.config.token.trim()}`;
    const res = await fetchWithTimeout(`${server}/`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        topic: this.config.topic.trim(),
        title: `${tone.label}: ${payload.subject}`,
        message: notifyBody(payload) || payload.subject,
        priority,
        tags,
        ...(isAbsoluteUrl(payload.deepLink) ? { click: payload.deepLink } : {}),
      }),
    });
    if (!res.ok) return { ok: false, channel: this.kind, detail: await failDetail(res) };
    return { ok: true, channel: this.kind };
  }
}

export class PushoverChannel implements AlertChannel {
  kind = "pushover";
  constructor(private readonly config: PushoverConfig) {}

  send(payload: AlertPayload): Promise<ChannelSendResult> {
    return guardSend(this.kind, () => this.sendUnsafe(payload));
  }

  private async sendUnsafe(payload: AlertPayload): Promise<ChannelSendResult> {
    const problem = validateChannelConfig("pushover", this.config as unknown as Record<string, unknown>);
    if (problem) return { ok: false, channel: this.kind, detail: problem };
    const base = (this.config.apiBaseUrl?.trim() || "https://api.pushover.net").replace(/\/+$/, "");
    const tone = alertTone(payload);
    // 1 = high priority (bypasses quiet hours); 0 normal; -1 no sound. Emergency (2) needs retry/expire, not used.
    const priority = payload.kind === "recovery" ? -1 : payload.severity === "critical" ? 1 : payload.severity === "info" ? -1 : 0;
    const form = new URLSearchParams({
      token: this.config.appToken.trim(),
      user: this.config.userKey.trim(),
      title: `${tone.emoji} ${tone.label}: ${payload.subject}`.slice(0, 250),
      message: (notifyBody(payload) || payload.subject).slice(0, 1024),
      priority: String(priority),
    });
    if (this.config.device?.trim()) form.set("device", this.config.device.trim());
    if (isAbsoluteUrl(payload.deepLink)) {
      form.set("url", payload.deepLink);
      form.set("url_title", "Open in Heimdall");
    }
    const res = await fetchWithTimeout(`${base}/1/messages.json`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const text = await res.text().catch(() => "");
    let json: { status?: number; errors?: string[] } = {};
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok || json.status === 0) {
      const why = json.errors?.join("; ") ?? text;
      return { ok: false, channel: this.kind, detail: `status ${res.status}${why ? `: ${why.slice(0, 200)}` : ""}` };
    }
    return { ok: true, channel: this.kind };
  }
}

export class TelegramChannel implements AlertChannel {
  kind = "telegram";
  constructor(private readonly config: TelegramConfig) {}

  send(payload: AlertPayload): Promise<ChannelSendResult> {
    return guardSend(this.kind, () => this.sendUnsafe(payload));
  }

  private async sendUnsafe(payload: AlertPayload): Promise<ChannelSendResult> {
    const problem = validateChannelConfig("telegram", this.config as unknown as Record<string, unknown>);
    if (problem) return { ok: false, channel: this.kind, detail: problem };
    const base = (this.config.apiBaseUrl?.trim() || "https://api.telegram.org").replace(/\/+$/, "");
    const tone = alertTone(payload);
    // Plain text (no parse_mode) so hostnames and values never need escaping. 4096 is Telegram's limit.
    const text = `${tone.emoji} ${formatAlertBody(payload)}`.slice(0, 4000);
    // The bot token lives in the URL path; never echo the URL back in a result.
    const res = await fetchWithTimeout(`${base}/bot${this.config.botToken.trim()}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.config.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      return {
        ok: false,
        channel: this.kind,
        detail: await failDetail(res, (j) => (typeof j.description === "string" ? j.description : undefined)),
      };
    }
    return { ok: true, channel: this.kind };
  }
}

export class PagerDutyChannel implements AlertChannel {
  kind = "pagerduty";
  constructor(private readonly config: PagerDutyConfig) {}

  send(payload: AlertPayload): Promise<ChannelSendResult> {
    return guardSend(this.kind, () => this.sendUnsafe(payload));
  }

  private async sendUnsafe(payload: AlertPayload): Promise<ChannelSendResult> {
    const problem = validateChannelConfig("pagerduty", this.config as unknown as Record<string, unknown>);
    if (problem) return { ok: false, channel: this.kind, detail: problem };
    const base = (this.config.apiBaseUrl?.trim() || "https://events.pagerduty.com").replace(/\/+$/, "");
    // Trigger and resolve must share a dedup_key. Host rules use the same subject for both.
    const dedupKey =
      payload.dedupKey ??
      createHash("sha256").update(`${payload.hostname ?? ""}|${payload.subject}`).digest("hex").slice(0, 32);
    const recovered = payload.kind === "recovery";
    const body = recovered
      ? { routing_key: this.config.routingKey.trim(), event_action: "resolve", dedup_key: dedupKey }
      : {
          routing_key: this.config.routingKey.trim(),
          event_action: "trigger",
          dedup_key: dedupKey,
          payload: {
            summary: `${payload.subject}: ${payload.message}`.slice(0, 1024),
            source: payload.hostname || "heimdall",
            severity: payload.severity === "critical" ? "critical" : payload.severity === "info" ? "info" : "warning",
            custom_details: Object.fromEntries((payload.fields ?? []).map((f) => [f.label, f.value])),
          },
          ...(isAbsoluteUrl(payload.deepLink) ? { links: [{ href: payload.deepLink, text: "Open in Heimdall" }] } : {}),
        };
    const res = await fetchWithTimeout(`${base}/v2/enqueue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return {
        ok: false,
        channel: this.kind,
        detail: await failDetail(res, (j) => (typeof j.message === "string" ? j.message : typeof j.status === "string" ? j.status : undefined)),
      };
    }
    return { ok: true, channel: this.kind };
  }
}

/** @deprecated Use SmsChannel — kept for import stability in older tests. */
export class SmsChannelStub extends SmsChannel {
  constructor() {
    super({
      accountSid: "",
      authToken: "",
      from: "",
      to: "",
    });
  }
}

export function createChannel(
  kind: string,
  config: Record<string, unknown>,
): AlertChannel {
  switch (kind) {
    case "smtp":
      return new SmtpChannel(config as SmtpConfig);
    case "slack":
      return new SlackChannel(config as WebhookConfig);
    case "discord":
      return new DiscordChannel(config as WebhookConfig);
    case "sms":
      return new SmsChannel(config as SmsConfig);
    case "ntfy":
      return new NtfyChannel(config as NtfyConfig);
    case "pushover":
      return new PushoverChannel(config as PushoverConfig);
    case "telegram":
      return new TelegramChannel(config as TelegramConfig);
    case "pagerduty":
      return new PagerDutyChannel(config as PagerDutyConfig);
    default:
      throw new Error(`unknown alert channel: ${kind}`);
  }
}
