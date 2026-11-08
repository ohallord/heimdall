import { describe, expect, it } from "vitest";
import { safeHttpUrl } from "./safe-url";

describe("safeHttpUrl", () => {
  it.each(["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<script>1</script>", "vbscript:x", "not a url", 42])(
    "drops %s",
    (v) => expect(safeHttpUrl(v)).toBeNull(),
  );
  it("keeps https advisories", () =>
    expect(safeHttpUrl("https://github.com/advisories/GHSA-x")).toBe("https://github.com/advisories/GHSA-x"));
});
