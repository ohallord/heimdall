import { describe, expect, it } from "vitest";
import {
  bandFor,
  hostBandDefaultsForMetric,
  HOST_BAND_DEFAULTS,
} from "./bands";

describe("bandFor", () => {
  it("returns green below warn", () => {
    expect(bandFor(84.9, 85, 95)).toBe("green");
    expect(bandFor(0, 85, 95)).toBe("green");
  });

  it("returns yellow at warn boundary and below alarm", () => {
    expect(bandFor(85, 85, 95)).toBe("yellow");
    expect(bandFor(94.9, 85, 95)).toBe("yellow");
  });

  it("returns red at alarm boundary", () => {
    expect(bandFor(95, 85, 95)).toBe("red");
    expect(bandFor(100, 85, 95)).toBe("red");
  });

  it("treats non-finite as green", () => {
    expect(bandFor(Number.NaN, 85, 95)).toBe("green");
  });
});

describe("hostBandDefaultsForMetric", () => {
  it("maps disk path metrics to disk defaults", () => {
    expect(hostBandDefaultsForMetric("disk_percent:/var")).toEqual(
      HOST_BAND_DEFAULTS.disk_percent,
    );
    expect(hostBandDefaultsForMetric("cpu_percent")).toEqual(
      HOST_BAND_DEFAULTS.cpu_percent,
    );
  });
});
