import { describe, expect, it } from "vitest";
import { syncSummary } from "./sync-summary";

// Bug: the page said "Synced 0 finding(s) · 2 warning(s)" and never showed
// what the warnings were, so a broken remote could not be diagnosed.
describe("syncSummary", () => {
  it("lists each warning's text", () => {
    const s = syncSummary({
      written: 0,
      errors: ["github dependabot 404: Not Found", "gitlab project not found: x"],
    });
    expect(s.message).toBe("Synced 0 finding(s) · 2 warning(s)");
    expect(s.warnings).toEqual([
      "github dependabot 404: Not Found",
      "gitlab project not found: x",
    ]);
  });

  it("handles a clean sync and junk input", () => {
    expect(syncSummary({ written: 3 })).toEqual({ message: "Synced 3 finding(s)", warnings: [] });
    expect(syncSummary(null)).toEqual({ message: "Synced 0 finding(s)", warnings: [] });
  });
});
