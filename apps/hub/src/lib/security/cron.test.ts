import { describe, expect, it } from "vitest";
import {
  DEFAULT_SECURITY_SYNC_CRON,
  describeCron,
  nextCronRun,
  nextCronRuns,
  parseCron,
  validateCron,
} from "./cron";

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("cron parsing", () => {
  it("defaults to daily at 08:00", () => {
    expect(DEFAULT_SECURITY_SYNC_CRON).toBe("0 8 * * *");
    expect(validateCron(DEFAULT_SECURITY_SYNC_CRON)).toBeNull();
  });

  it("accepts lists, ranges, steps and names", () => {
    for (const expr of [
      "*/15 * * * *",
      "0 8,20 * * 1-5",
      "30 2 1 */2 *",
      "0 0 * JAN-MAR mon,wed,FRI",
      "5-55/10 0-23/6 * * 7",
      "  0   8 * *   * ",
    ]) {
      expect(validateCron(expr), expr).toBeNull();
    }
  });

  it("rejects malformed expressions with a reason", () => {
    for (const expr of [
      "",
      "0 8 * *",
      "0 8 * * * *",
      "60 8 * * *",
      "0 24 * * *",
      "0 8 0 * *",
      "0 8 * 13 *",
      "0 8 * * 8",
      "*/0 * * * *",
      "5-1 * * * *",
      "a b c d e",
      "0 8 * * MON-",
      "@daily",
    ]) {
      expect(validateCron(expr), expr).toMatch(/.+/);
    }
  });

  it("expands fields", () => {
    const c = parseCron("*/20 8 1,15 * 7");
    expect([...c.minute]).toEqual([0, 20, 40]);
    expect([...c.hour]).toEqual([8]);
    expect([...c.dayOfMonth]).toEqual([1, 15]);
    expect([...c.dayOfWeek]).toEqual([0]);
    expect(c.domRestricted).toBe(true);
    expect(c.dowRestricted).toBe(true);
  });
});

describe("next run", () => {
  it("finds the next daily 08:00 in UTC", () => {
    const after = new Date("2026-11-14T07:59:30Z");
    expect(iso(nextCronRun("0 8 * * *", after, "UTC"))).toBe("2026-11-14T08:00:00.000Z");
    expect(iso(nextCronRun("0 8 * * *", new Date("2026-11-14T08:00:00Z"), "UTC"))).toBe(
      "2026-11-15T08:00:00.000Z",
    );
  });

  it("applies the time zone", () => {
    // 08:00 in New York is 13:00Z in winter (EST) and 12:00Z in summer (EDT).
    expect(iso(nextCronRun("0 8 * * *", new Date("2026-11-14T00:00:00Z"), "America/New_York"))).toBe(
      "2026-11-14T13:00:00.000Z",
    );
    expect(iso(nextCronRun("0 8 * * *", new Date("2026-07-01T00:00:00Z"), "America/New_York"))).toBe(
      "2026-07-01T12:00:00.000Z",
    );
  });

  it("crosses a DST change at the right instant", () => {
    // US DST ends 2026-11-01: 08:00 on Oct 31 is EDT, on Nov 1 is EST.
    const runs = nextCronRuns("0 8 * * *", new Date("2026-10-31T00:00:00Z"), "America/New_York", 2);
    expect(runs.map(iso)).toEqual(["2026-10-31T12:00:00.000Z", "2026-11-01T13:00:00.000Z"]);
  });

  it("skips a wall time that does not exist in a DST gap", () => {
    // 2027-03-14 02:30 does not exist in New York; next is 02:30 on Mar 15.
    expect(
      iso(nextCronRun("30 2 * * *", new Date("2027-03-14T00:00:00Z"), "America/New_York")),
    ).toBe("2027-03-15T06:30:00.000Z");
  });

  it("ORs day-of-month and day-of-week when both are set", () => {
    // 2026-11-14 is a Saturday. "1st of month or Monday" → Mon 16th.
    expect(iso(nextCronRun("0 0 1 * 1", new Date("2026-11-14T00:00:00Z"), "UTC"))).toBe(
      "2026-11-16T00:00:00.000Z",
    );
  });

  it("handles steps, weekdays and leap days", () => {
    expect(iso(nextCronRun("*/15 * * * *", new Date("2026-11-14T10:07:00Z"), "UTC"))).toBe(
      "2026-11-14T10:15:00.000Z",
    );
    expect(iso(nextCronRun("0 9 * * 1-5", new Date("2026-11-14T00:00:00Z"), "UTC"))).toBe(
      "2026-11-16T09:00:00.000Z",
    );
    expect(iso(nextCronRun("0 0 29 2 *", new Date("2026-11-14T00:00:00Z"), "UTC"))).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("returns null for a date that never occurs", () => {
    expect(nextCronRun("0 0 31 2 *", new Date("2026-11-14T00:00:00Z"), "UTC")).toBeNull();
  });
});

describe("describeCron", () => {
  it("reads common schedules", () => {
    expect(describeCron("0 8 * * *")).toBe("Every day at 08:00");
    expect(describeCron("30 6 * * 1-5")).toBe("Monday to Friday at 06:30");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours at minute 0");
  });
});
