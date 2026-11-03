import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";

describe("redactSecrets", () => {
  it("redacts every Heimdall token prefix, keeping the prefix", () => {
    const line = [
      "TOKEN=hdt_FAKEtoken0000000000000000000000000000",
      "secret=hda_Zx9-_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678",
      "hdb_abcdefghijklmnopqrstuv",
      "OTEL_TOKEN=hdo_0123456789abcdef0123",
      "hdu_0123456789abcdefABCD hdr_0123456789abcdefABCD",
    ].join(" ");
    expect(redactSecrets(line)).toBe(
      "TOKEN=hdt_[REDACTED] secret=hda_[REDACTED] hdb_[REDACTED] OTEL_TOKEN=hdo_[REDACTED] hdu_[REDACTED] hdr_[REDACTED]",
    );
  });

  it("leaves ids and short or unrelated strings alone", () => {
    const line = "agent agt_hosu3bf41d8cm38h hdt_short shadow_password=x";
    expect(redactSecrets(line)).toBe(line);
  });
});
