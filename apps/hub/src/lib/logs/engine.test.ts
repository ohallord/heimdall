import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateLogLine,
  evaluateLogLines,
  highestSeverity,
  logMatchMetric,
} from "./engine";
import { DEFAULT_LOG_RULES } from "./rules";

function fixtureLines(name: string): string[] {
  return readFileSync(path.join(__dirname, "fixtures", name), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

describe("log rule engine (golden fixtures)", () => {
  it("detects failed SSH from auth fixture", () => {
    const results = evaluateLogLines(fixtureLines("auth-ssh.log"));
    const matched = results.filter((r) => r.matches.length > 0);
    expect(matched.length).toBeGreaterThanOrEqual(3);
    expect(
      matched.every((r) =>
        r.matches.some((m) => m.ruleId === "ssh_failed_password"),
      ),
    ).toBe(true);
  });

  it("detects sudo abuse from fixture", () => {
    const results = evaluateLogLines(fixtureLines("sudo-abuse.log"));
    const ids = results.flatMap((r) => r.matches.map((m) => m.ruleId));
    expect(ids).toContain("sudo_abuse");
    expect(highestSeverity(results.flatMap((r) => r.matches))).toBe("high");
  });

  it("tags routine sudo commands as audit-only, not sudo abuse", () => {
    const ok = evaluateLogLine(
      "Nov  1 20:11:52 homelab sudo: dan : TTY=/dev/pts/0 ; PWD=/home/dan ; USER=root ; COMMAND=/usr/bin/bash",
    );
    expect(ok.matches.map((m) => m.ruleId)).toEqual(["sudo_command"]);
    expect(highestSeverity(ok.matches)).toBe("low");
    const denied = evaluateLogLine(
      "Oct 21 00:12:10 edge sudo: unknown : user NOT in sudoers file ; TTY=pts/1 ; PWD=/tmp ; USER=root ; COMMAND=/bin/cat /etc/shadow",
    );
    expect(denied.matches.map((m) => m.ruleId)).toContain("sudo_abuse");
    expect(
      evaluateLogLine("Nov  1 20:11:52 edge sudo: bob : 3 incorrect password attempts ; TTY=pts/0")
        .matches.map((m) => m.ruleId),
    ).toContain("sudo_abuse");
  });

  it("detects reverse shell strings", () => {
    const results = evaluateLogLines(fixtureLines("reverse-shell.log"));
    const hits = results.filter((r) =>
      r.matches.some((m) => m.ruleId === "reverse_shell"),
    );
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(highestSeverity(hits.flatMap((r) => r.matches))).toBe("critical");
  });

  it("detects crypto miner indicators", () => {
    const results = evaluateLogLines(fixtureLines("crypto-miner.log"));
    const hits = results.filter((r) =>
      r.matches.some((m) => m.ruleId === "crypto_miner"),
    );
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("detects webshell / C2 download indicators", () => {
    const results = evaluateLogLines(fixtureLines("webshell.log"));
    const hits = results.filter((r) =>
      r.matches.some((m) => m.ruleId === "webshell_indicator"),
    );
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(highestSeverity(hits.flatMap((r) => r.matches))).toBe("critical");
  });

  it("detects privilege escalation indicators", () => {
    const results = evaluateLogLines(fixtureLines("priv-esc.log"));
    const hits = results.filter((r) =>
      r.matches.some((m) => m.ruleId === "privilege_escalation"),
    );
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(highestSeverity(hits.flatMap((r) => r.matches))).toBe("high");
  });

  it("does not false-positive on benign fixture", () => {
    const results = evaluateLogLines(fixtureLines("benign.log"));
    expect(results.every((r) => r.matches.length === 0)).toBe(true);
  });

  it("exposes metric keys for alert wiring", () => {
    expect(logMatchMetric("ssh_failed_password")).toBe(
      "log_match:ssh_failed_password",
    );
    expect(DEFAULT_LOG_RULES.map((r) => r.id).sort()).toEqual([
      "crypto_miner",
      "privilege_escalation",
      "reverse_shell",
      "ssh_failed_password",
      "sudo_abuse",
      "sudo_command",
      "webshell_indicator",
    ]);
  });

  it("returns empty matches for blank lines", () => {
    expect(evaluateLogLine("").matches).toEqual([]);
  });
});
