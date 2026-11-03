import { describe, expect, it } from "vitest";
import {
  isInQuietHours,
  isWithinQuietWindow,
  parseHmToMinutes,
  shouldSuppressForQuietHours,
} from "./quiet-hours";

describe("quiet hours", () => {
  it("parses HH:MM", () => {
    expect(parseHmToMinutes("22:00")).toBe(22 * 60);
    expect(parseHmToMinutes("7:30")).toBe(7 * 60 + 30);
    expect(parseHmToMinutes("bad")).toBeNull();
  });

  it("handles overnight windows", () => {
    expect(isWithinQuietWindow(23 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(isWithinQuietWindow(3 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(isWithinQuietWindow(12 * 60, 22 * 60, 7 * 60)).toBe(false);
  });

  it("handles same-day windows", () => {
    expect(isWithinQuietWindow(13 * 60, 12 * 60, 14 * 60)).toBe(true);
    expect(isWithinQuietWindow(11 * 60, 12 * 60, 14 * 60)).toBe(false);
  });

  it("respects enabled flag and timezone-local clock", () => {
    // 2026-01-15 03:00 UTC
    const now = new Date("2026-01-15T03:00:00.000Z");
    expect(
      isInQuietHours(
        {
          enabled: true,
          start: "22:00",
          end: "07:00",
          timezone: "UTC",
        },
        now,
      ),
    ).toBe(true);
    expect(
      isInQuietHours(
        {
          enabled: false,
          start: "22:00",
          end: "07:00",
          timezone: "UTC",
        },
        now,
      ),
    ).toBe(false);
  });

  it("suppresses only when every quiet-hours user is inside the window", () => {
    const now = new Date("2026-01-15T03:00:00.000Z");
    expect(
      shouldSuppressForQuietHours(
        [
          {
            enabled: true,
            start: "22:00",
            end: "07:00",
            timezone: "UTC",
          },
        ],
        "warning",
        now,
      ),
    ).toBe(true);

    expect(
      shouldSuppressForQuietHours(
        [
          {
            enabled: true,
            start: "22:00",
            end: "07:00",
            timezone: "UTC",
          },
        ],
        "critical",
        now,
      ),
    ).toBe(false);

    expect(
      shouldSuppressForQuietHours(
        [
          {
            enabled: true,
            start: "22:00",
            end: "07:00",
            timezone: "UTC",
          },
          {
            enabled: true,
            start: "12:00",
            end: "13:00",
            timezone: "UTC",
          },
        ],
        "warning",
        now,
      ),
    ).toBe(false);
  });
});
