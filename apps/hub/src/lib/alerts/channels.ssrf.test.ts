import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordChannel, SlackChannel, SmsChannel } from "./channels";
import { fetchGitHubDependabotAlerts } from "@/lib/security/github";
import { fetchGitLabVulnerabilities } from "@/lib/security/gitlab";

const payload = { subject: "s", message: "m" };

describe("outbound SSRF guard on admin-configured URLs", () => {
  afterEach(() => {
    delete process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS;
  });

  it.each([
    ["loopback", "http://127.0.0.1:9/hook"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data"],
    ["RFC1918", "http://10.0.0.5/hook"],
    ["IPv6 loopback", "http://[::1]/hook"],
    ["non-http scheme", "file:///etc/passwd"],
  ])("Slack/Discord refuse %s with blocked_host and do not connect", async (_n, url) => {
    for (const ch of [new SlackChannel({ url }), new DiscordChannel({ url })]) {
      const r = await ch.send(payload);
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/blocked_host/);
    }
  });

  it("SMS refuses a private apiBaseUrl", async () => {
    const r = await new SmsChannel({
      accountSid: "AC1", authToken: "t", from: "+1", to: "+2", apiBaseUrl: "http://169.254.169.254",
    } as never).send(payload);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/blocked_host/);
  });

  it("GitHub and GitLab clients refuse private API base URLs by default", async () => {
    await expect(
      fetchGitHubDependabotAlerts({ token: "t", org: "o", apiBaseUrl: "http://169.254.169.254" }),
    ).rejects.toThrow(/blocked_host/);
    await expect(
      fetchGitLabVulnerabilities({ token: "t", projectPath: "g/p", apiBaseUrl: "http://127.0.0.1:1/api/graphql" }),
    ).rejects.toThrow(/blocked_host/);
  });

  it("HEIMDALL_ALLOW_PRIVATE_HOSTS lets a LAN webhook through", async () => {
    let hits = 0;
    const srv = http.createServer((_q, res) => {
      hits++;
      res.end("ok");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`;
    try {
      expect((await new SlackChannel({ url }).send(payload)).ok).toBe(false);
      expect(hits).toBe(0);
      process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS = "127.0.0.1";
      expect((await new SlackChannel({ url }).send(payload)).ok).toBe(true);
      expect(hits).toBe(1);
    } finally {
      srv.close();
    }
  });
});

describe("SmtpChannel send-time SSRF guard", () => {
  it("refuses to connect to a private SMTP host that is not allowlisted", async () => {
    const { SmtpChannel } = await import("./channels");
    delete process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS;
    const ch = new SmtpChannel({ host: "169.254.169.254", port: 80, from: "a@x.io", to: "b@x.io" } as never);
    await expect(
      ch.send({ title: "t", severity: "critical", message: "m" } as never),
    ).rejects.toThrow(/blocked_host/);
  });
});
