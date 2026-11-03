import { describe, expect, it } from "vitest";
import * as OTPAuth from "otpauth";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotp,
} from "./totp";

describe("TOTP + recovery codes", () => {
  it("generates a verifiable TOTP secret", () => {
    const { secret } = generateTotpSecret("admin@example.com");
    const totp = new OTPAuth.TOTP({
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const token = totp.generate();
    expect(verifyTotp(secret, token)).toBe(true);
    expect(verifyTotp(secret, "000000")).toBe(false);
  });

  it("hashes recovery codes stably", () => {
    const codes = generateRecoveryCodes(2);
    expect(codes).toHaveLength(2);
    expect(hashRecoveryCode(codes[0])).toBe(hashRecoveryCode(codes[0].toLowerCase()));
    expect(hashRecoveryCode(codes[0])).not.toBe(hashRecoveryCode(codes[1]));
  });
});
