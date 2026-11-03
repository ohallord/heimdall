import nodemailer from "nodemailer";
import { BlockedHostError, guardedFetch } from "@/lib/http-guard/safe-fetch";
import {
  formatAlertBody,
  formatAlertHtml,
  formatDiscordMessage,
  formatSlackMessage,
  formatSmsBody,
  formatSubject,
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

export class SmtpChannel implements AlertChannel {
  kind = "smtp";
  constructor(private readonly config: SmtpConfig) {}

  async send(payload: AlertPayload): Promise<ChannelSendResult> {
    const transport = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure ?? false,
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
    default:
      throw new Error(`unknown alert channel: ${kind}`);
  }
}
