import type { AlertPayload } from "./channels";

/** Absolute or relative deep link to an alert in the hub UI. */
export function alertDeepLink(eventId: string): string {
  const base = (
    process.env.HEIMDALL_PUBLIC_BASE_URL?.trim() ||
    process.env.HEIMDALL_PUBLIC_URL?.trim() ||
    ""
  ).replace(/\/$/, "");
  const path = `/dashboard/alerts?id=${encodeURIComponent(eventId)}`;
  return base ? `${base}${path}` : path;
}

/** Buttons/links in email and Slack only work with absolute http(s) URLs. */
export function isAbsoluteUrl(link: string | undefined): link is string {
  return !!link && /^https?:\/\//i.test(link);
}

// ---------------------------------------------------------------------------
// Human-friendly metric labels
// ---------------------------------------------------------------------------

const METRIC_LABELS: Record<string, string> = {
  cpu_percent: "CPU usage",
  mem_percent: "Memory usage",
  disk_percent: "Disk usage",
  mount_missing: "Mount missing",
  container_exited: "Container exited",
  container_oom: "Container out of memory",
  container_restart_loop: "Container restart loop",
  container_mem_limit_pct: "Container memory (of limit)",
  container_cpu_pct: "Container CPU",
  k8s_apiserver_unreachable: "Kubernetes API unreachable",
  k8s_node_not_ready: "Kubernetes nodes not ready",
  k8s_pod_pending: "Kubernetes pods pending",
  k8s_pod_crashloop: "Kubernetes pods crash-looping",
  k8s_deployment_unhealthy: "Kubernetes deployments unhealthy",
};

/** "disk_percent:/var" → "Disk usage (/var)"; unknown metrics pass through. */
export function metricLabel(metric: string): string {
  const idx = metric.indexOf(":");
  const base = idx === -1 ? metric : metric.slice(0, idx);
  const suffix = idx === -1 ? "" : metric.slice(idx + 1);
  const label = METRIC_LABELS[base] ?? base;
  return suffix ? `${label} (${suffix})` : label;
}

function isPercentMetric(metric: string): boolean {
  const base = metric.split(":")[0];
  return base.endsWith("_percent") || base.endsWith("_pct");
}

/** 95.12345 → "95.1%" for percent metrics, otherwise trimmed number. */
export function formatMetricValue(metric: string, value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.round(value * 10) / 10;
  return isPercentMetric(metric) ? `${rounded}%` : String(rounded);
}

const OPERATOR_SYMBOLS: Record<string, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  eq: "=",
};

/** ("gte", 90, "cpu_percent") → "≥ 90%". */
export function formatThreshold(
  operator: string,
  threshold: number,
  metric: string,
): string {
  const sym = OPERATOR_SYMBOLS[operator] ?? operator;
  return `${sym} ${formatMetricValue(metric, threshold)}`;
}

/** 754_000 → "12m 34s"; 7_300_000 → "2h 1m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const s = totalSec % 60;
    return s ? `${totalMin}m ${s}s` : `${totalMin}m`;
  }
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const m = totalMin % 60;
    return m ? `${totalHr}h ${m}m` : `${totalHr}h`;
  }
  const d = Math.floor(totalHr / 24);
  const h = totalHr % 24;
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** "2026-11-02 14:03 UTC" — compact and unambiguous across recipients. */
export function formatTimestamp(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// ---------------------------------------------------------------------------
// Presentation shared by every channel
// ---------------------------------------------------------------------------

export type AlertTone = {
  /** Short status word shown as a badge / prefix. */
  label: string;
  emoji: string;
  /** Hex colour used for email header, Slack bar, Discord embed. */
  color: string;
};

export function alertTone(payload: AlertPayload): AlertTone {
  if (payload.kind === "recovery") {
    return { label: "Recovered", emoji: "✅", color: "#198038" };
  }
  switch (payload.severity) {
    case "critical":
      return { label: "Critical", emoji: "🔴", color: "#da1e28" };
    case "info":
      return { label: "Info", emoji: "ℹ️", color: "#007d79" };
    default:
      return { label: "Warning", emoji: "🟠", color: "#b28600" };
  }
}

/** Email subject line (channels add nothing further). */
export function formatSubject(payload: AlertPayload): string {
  const tone = alertTone(payload);
  return `[Heimdall] ${tone.label}: ${payload.subject}`;
}

/** Multi-line plain-text body (email text part, Slack/Discord fallback). */
export function formatAlertBody(payload: AlertPayload): string {
  const tone = alertTone(payload);
  const lines: string[] = [`${tone.label.toUpperCase()} — ${payload.subject}`, ""];
  if (payload.message) lines.push(payload.message, "");
  if (payload.fields?.length) {
    const width = Math.max(...payload.fields.map((f) => f.label.length));
    for (const field of payload.fields) {
      lines.push(`${`${field.label}:`.padEnd(width + 2)}${field.value}`);
    }
    lines.push("");
  }
  if (payload.deepLink) {
    lines.push(`View: ${payload.deepLink}`);
  }
  return lines.join("\n").trimEnd();
}

/** Short SMS body; prefers summary + link within Twilio limit. */
export function formatSmsBody(payload: AlertPayload): string {
  const tone = alertTone(payload);
  const summary = `[Heimdall] ${tone.label}: ${payload.subject} — ${payload.message}`;
  if (!payload.deepLink) return summary.slice(0, 1600);
  const withLink = `${summary} ${payload.deepLink}`;
  if (withLink.length <= 1600) return withLink;
  const budget = 1600 - payload.deepLink.length - 1;
  if (budget < 40) return payload.deepLink.slice(0, 1600);
  return `${summary.slice(0, budget)} ${payload.deepLink}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Table-based, inline-styled HTML email (renders in Gmail/Outlook/Apple Mail).
 */
export function formatAlertHtml(payload: AlertPayload): string {
  const tone = alertTone(payload);
  const font =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const rows = (payload.fields ?? [])
    .map(
      (f) => `
            <tr>
              <td style="padding:8px 12px 8px 0;border-top:1px solid #eef0f2;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(f.label)}</td>
              <td style="padding:8px 0;border-top:1px solid #eef0f2;color:#111827;font-size:14px;word-break:break-word;">${escapeHtml(f.value)}</td>
            </tr>`,
    )
    .join("");
  const button = isAbsoluteUrl(payload.deepLink)
    ? `
          <tr>
            <td style="padding:8px 24px 24px 24px;">
              <a href="${escapeHtml(payload.deepLink)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:6px;">View in Heimdall</a>
            </td>
          </tr>`
    : "";

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f4f6;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px;font-family:${font};">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
            <tr>
              <td style="background:${tone.color};padding:14px 24px;color:#ffffff;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">
                ${tone.emoji} ${escapeHtml(tone.label)}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 24px 4px 24px;">
                <h1 style="margin:0;font-size:20px;line-height:1.3;color:#111827;">${escapeHtml(payload.subject)}</h1>
                ${payload.message ? `<p style="margin:8px 0 0 0;font-size:15px;line-height:1.5;color:#374151;">${escapeHtml(payload.message)}</p>` : ""}
              </td>
            </tr>
            ${
              rows
                ? `<tr>
              <td style="padding:16px 24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
                </table>
              </td>
            </tr>`
                : ""
            }${button}
          </table>
          <p style="margin:16px 0 0 0;font-size:12px;color:#9ca3af;">Sent by Heimdall</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Slack mrkdwn needs &, <, > escaped. */
function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Slack incoming-webhook body: coloured attachment with Block Kit content. */
export function formatSlackMessage(payload: AlertPayload): Record<string, unknown> {
  const tone = alertTone(payload);
  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `${tone.emoji} *${slackEscape(tone.label)}: ${slackEscape(payload.subject)}*` +
          (payload.message ? `\n${slackEscape(payload.message)}` : ""),
      },
    },
  ];
  const fields = payload.fields ?? [];
  // Slack allows at most 10 fields per section block.
  for (let i = 0; i < fields.length; i += 10) {
    blocks.push({
      type: "section",
      fields: fields.slice(i, i + 10).map((f) => ({
        type: "mrkdwn",
        text: `*${slackEscape(f.label)}*\n${slackEscape(f.value)}`,
      })),
    });
  }
  if (isAbsoluteUrl(payload.deepLink)) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View in Heimdall" },
          url: payload.deepLink,
        },
      ],
    });
  } else if (payload.deepLink) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `View: ${slackEscape(payload.deepLink)}` }],
    });
  }
  return {
    // Fallback for notifications / clients without Block Kit.
    text: `${tone.emoji} ${tone.label}: ${payload.subject}`,
    attachments: [{ color: tone.color, blocks }],
  };
}

/** Discord webhook body: a single coloured embed. */
export function formatDiscordMessage(
  payload: AlertPayload,
): Record<string, unknown> {
  const tone = alertTone(payload);
  const embed: Record<string, unknown> = {
    title: `${tone.emoji} ${tone.label}: ${payload.subject}`.slice(0, 256),
    color: parseInt(tone.color.slice(1), 16),
    timestamp: new Date().toISOString(),
    footer: { text: "Heimdall" },
  };
  const description = [
    payload.message,
    payload.deepLink && !isAbsoluteUrl(payload.deepLink)
      ? `View: ${payload.deepLink}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (description) embed.description = description.slice(0, 4096);
  if (isAbsoluteUrl(payload.deepLink)) embed.url = payload.deepLink;
  if (payload.fields?.length) {
    embed.fields = payload.fields.slice(0, 25).map((f) => ({
      name: f.label.slice(0, 256),
      value: (f.value || "—").slice(0, 1024),
      inline: f.value.length <= 40,
    }));
  }
  return { embeds: [embed] };
}
