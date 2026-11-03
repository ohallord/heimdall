import { describe, expect, it } from "vitest";
import { readJsonLimited } from "./body";

const req = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://x/", { method: "POST", body, headers });

describe("readJsonLimited", () => {
  it("parses valid JSON under the limit", async () => {
    const r = await readJsonLimited(req('{"a":1}'), 100);
    expect(r).toEqual({ ok: true, value: { a: 1 } });
  });
  it("413 when content-length exceeds limit", async () => {
    const r = await readJsonLimited(req('{"a":1}', { "content-length": "5000" }), 100);
    expect(r).toEqual({ ok: false, status: 413 });
  });
  it("413 when streamed body exceeds limit without content-length", async () => {
    const big = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a":"' + "x".repeat(200)));
        c.enqueue(new TextEncoder().encode('"}'));
        c.close();
      },
    });
    const r = new Request("http://x/", { method: "POST", body: big, duplex: "half" } as RequestInit);
    expect(await readJsonLimited(r, 100)).toEqual({ ok: false, status: 413 });
  });
  it("400 on invalid JSON", async () => {
    expect(await readJsonLimited(req("{nope"), 100)).toEqual({ ok: false, status: 400 });
  });
  it("400 on empty body", async () => {
    expect(await readJsonLimited(req(null), 100)).toEqual({ ok: false, status: 400 });
  });
});
