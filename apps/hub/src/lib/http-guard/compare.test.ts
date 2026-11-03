import { describe, expect, it } from "vitest";
import { safeEqual } from "./compare";

describe("safeEqual", () => {
  it("matches equal strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("", "")).toBe(true);
  });
  it("rejects different strings, including different lengths", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "a")).toBe(false);
  });
  it("handles unicode", () => {
    expect(safeEqual("pässword", "pässword")).toBe(true);
    expect(safeEqual("pässword", "passw0rd")).toBe(false);
  });
});
