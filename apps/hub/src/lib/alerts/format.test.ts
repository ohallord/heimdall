import { afterEach, describe, expect, it } from "vitest";
import {
  alertDeepLink,
  formatAlertBody,
  formatAlertHtml,
  formatDiscordMessage,
  formatDuration,
  formatMetricValue,
  formatSlackMessage,
  formatSmsBody,
  formatSubject,
  formatThreshold,
  metricLabel,
} from "./format";

afterEach(() => {
  delete process.env.HEIMDALL_PUBLIC_BASE_URL;
});

const alert = {
  subject: "CPU high on edge-01",
  message: "CPU usage is 95% (alarm at ≥ 90%).",
  severity: "critical" as const,
  fields: [
    { label: "Host", value: "edge-01" },
    { label: "Metric", value: "CPU usage" },
  ],
  deepLink: "https://hub.example/dashboard/alerts?id=evt_1",
};

describe("formatAlertBody", () => {
  it("includes status, fields and deep link", () => {
    const body = formatAlertBody(alert);
    expect(body).toContain("CRITICAL — CPU high on edge-01");
    expect(body).toContain("CPU usage is 95%");
    expect(body).toMatch(/Host:\s+edge-01/);
    expect(body).toMatch(/Metric:\s+CPU usage/);
    expect(body).toContain("View: https://hub.example/dashboard/alerts?id=evt_1");
  });
});

describe("formatSubject", () => {
  it("prefixes severity, or Recovered for recovery notifications", () => {
    expect(formatSubject(alert)).toBe("[Heimdall] Critical: CPU high on edge-01");
    expect(formatSubject({ ...alert, kind: "recovery", severity: "info" })).toBe(
      "[Heimdall] Recovered: CPU high on edge-01",
    );
  });
});

describe("formatAlertHtml", () => {
  it("escapes content and renders a button for absolute links", () => {
    const html = formatAlertHtml({
      ...alert,
      fields: [{ label: "Path", value: "<script>x</script>" }],
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("View in Heimdall");
    expect(html).toContain("#da1e28");
  });

  it("omits the button for relative links", () => {
    const html = formatAlertHtml({ ...alert, deepLink: "/dashboard/alerts?id=1" });
    expect(html).not.toContain("View in Heimdall");
  });

  it("uses green for recoveries", () => {
    expect(formatAlertHtml({ ...alert, kind: "recovery" })).toContain("#198038");
  });
});

describe("formatSlackMessage", () => {
  it("builds a coloured attachment with fields and a link button", () => {
    const msg = formatSlackMessage(alert) as {
      text: string;
      attachments: { color: string; blocks: { type: string }[] }[];
    };
    expect(msg.text).toContain("Critical: CPU high on edge-01");
    expect(msg.attachments[0].color).toBe("#da1e28");
    const types = msg.attachments[0].blocks.map((b) => b.type);
    expect(types).toEqual(["section", "section", "actions"]);
  });

  it("splits more than 10 fields across section blocks", () => {
    const fields = Array.from({ length: 12 }, (_, i) => ({
      label: `F${i}`,
      value: String(i),
    }));
    const msg = formatSlackMessage({ subject: "s", message: "m", fields }) as {
      attachments: { blocks: { type: string; fields?: unknown[] }[] }[];
    };
    const sections = msg.attachments[0].blocks.filter((b) => b.fields);
    expect(sections.map((b) => b.fields!.length)).toEqual([10, 2]);
  });
});

describe("formatDiscordMessage", () => {
  it("builds a single embed with colour and url", () => {
    const msg = formatDiscordMessage(alert) as {
      embeds: { color: number; url?: string; fields: unknown[] }[];
    };
    expect(msg.embeds[0].color).toBe(0xda1e28);
    expect(msg.embeds[0].url).toBe(alert.deepLink);
    expect(msg.embeds[0].fields).toHaveLength(2);
  });
});

describe("formatSmsBody", () => {
  it("keeps summary short and appends link when present", () => {
    const body = formatSmsBody({
      subject: "CPU high",
      message: "observed 95",
      deepLink: "/dashboard/alerts?id=evt_1",
    });
    expect(body).toContain("[Heimdall] Warning: CPU high");
    expect(body).toContain("/dashboard/alerts?id=evt_1");
    expect(body.length).toBeLessThanOrEqual(1600);
  });
});

describe("metric helpers", () => {
  it("labels metrics and formats values", () => {
    expect(metricLabel("disk_percent:/var")).toBe("Disk usage (/var)");
    expect(metricLabel("weird_metric")).toBe("weird_metric");
    expect(formatMetricValue("cpu_percent", 95.1234)).toBe("95.1%");
    expect(formatMetricValue("k8s_pod_pending", 3)).toBe("3");
    expect(formatThreshold("gte", 90, "mem_percent")).toBe("≥ 90%");
  });

  it("formats durations", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(754_000)).toBe("12m 34s");
    expect(formatDuration(7_300_000)).toBe("2h 1m");
    expect(formatDuration(90_000_000)).toBe("1d 1h");
  });
});

describe("alertDeepLink", () => {
  it("uses relative path when base URL unset", () => {
    expect(alertDeepLink("evt_abc")).toBe("/dashboard/alerts?id=evt_abc");
  });

  it("prefixes HEIMDALL_PUBLIC_BASE_URL when set", () => {
    process.env.HEIMDALL_PUBLIC_BASE_URL = "https://heimdall.example/";
    expect(alertDeepLink("evt_abc")).toBe(
      "https://heimdall.example/dashboard/alerts?id=evt_abc",
    );
  });
});
