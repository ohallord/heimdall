import { describe, expect, it } from "vitest";
import {
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
} from "./password";

describe("password helpers", () => {
  it("validates strength", () => {
    expect(validatePasswordStrength("short")).toMatch(/at least 10/);
    expect(validatePasswordStrength("allletters")).toMatch(/letters and numbers/);
    expect(validatePasswordStrength("GoodPass12")).toBeNull();
  });

  it("hashes and verifies", async () => {
    const hash = await hashPassword("GoodPass12");
    expect(await verifyPassword("GoodPass12", hash)).toBe(true);
    expect(await verifyPassword("nope", hash)).toBe(false);
  });
});
