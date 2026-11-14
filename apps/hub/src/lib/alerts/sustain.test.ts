import { beforeEach, describe, expect, it } from "vitest";
import {
  breachSustained,
  clearBreach,
  markBreach,
  resetSustainState,
  SUSTAIN_STALE_MS,
} from "./sustain";

const T0 = 1_000_000;

describe("breach sustain tracker", () => {
  beforeEach(() => resetSustainState());

  it("fires immediately when the window is 0", () => {
    markBreach("a", T0);
    expect(breachSustained("a", T0, 0)).toBe(true);
  });

  it("holds the alert until the breach has lasted the full window", () => {
    markBreach("a", T0);
    expect(breachSustained("a", T0, 120_000)).toBe(false);
    markBreach("a", T0 + 60_000);
    expect(breachSustained("a", T0 + 60_000, 120_000)).toBe(false);
    markBreach("a", T0 + 119_999);
    expect(breachSustained("a", T0 + 119_999, 120_000)).toBe(false);
    markBreach("a", T0 + 120_000);
    expect(breachSustained("a", T0 + 120_000, 120_000)).toBe(true);
  });

  it("a healthy sample resets the clock, so a 40s blip never fires", () => {
    markBreach("a", T0);
    markBreach("a", T0 + 20_000);
    clearBreach("a");
    markBreach("a", T0 + 40_000);
    expect(breachSustained("a", T0 + 100_000, 120_000)).toBe(false);
    markBreach("a", T0 + 160_000);
    expect(breachSustained("a", T0 + 160_000, 120_000)).toBe(true);
  });

  it("tracks each alert identity separately", () => {
    markBreach("a", T0);
    markBreach("b", T0 + 90_000);
    expect(breachSustained("a", T0 + 120_000, 120_000)).toBe(true);
    expect(breachSustained("b", T0 + 120_000, 120_000)).toBe(false);
  });

  it("restarts the clock after the agent went silent for a long gap", () => {
    markBreach("a", T0);
    const later = T0 + SUSTAIN_STALE_MS + 1;
    markBreach("a", later);
    expect(breachSustained("a", later, 120_000)).toBe(false);
  });

  it("is not sustained when nothing was marked", () => {
    expect(breachSustained("never", T0, 60_000)).toBe(false);
  });
});
