import { afterEach, describe, expect, it } from "vitest";
import { sessionOptions } from "./session";

describe("sessionPassword production fail-closed", () => {
  const prevSecret = process.env.HEIMDALL_SESSION_SECRET;
  const prevNode = process.env.NODE_ENV;

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.HEIMDALL_SESSION_SECRET;
    else process.env.HEIMDALL_SESSION_SECRET = prevSecret;
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
  });

  it("uses configured secret", () => {
    process.env.HEIMDALL_SESSION_SECRET = "a".repeat(32);
    process.env.NODE_ENV = "production";
    expect(sessionOptions().password).toBe("a".repeat(32));
  });

  it("throws in production without secret", () => {
    delete process.env.HEIMDALL_SESSION_SECRET;
    process.env.NODE_ENV = "production";
    expect(() => sessionOptions()).toThrow(/HEIMDALL_SESSION_SECRET/);
  });

  it("allows dev fallback outside production", () => {
    delete process.env.HEIMDALL_SESSION_SECRET;
    process.env.NODE_ENV = "test";
    expect(String(sessionOptions().password).length).toBeGreaterThanOrEqual(32);
  });
});

describe("published session secrets", () => {
  const prevSecret = process.env.HEIMDALL_SESSION_SECRET;
  const prevNode = process.env.NODE_ENV;
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.HEIMDALL_SESSION_SECRET;
    else process.env.HEIMDALL_SESSION_SECRET = prevSecret;
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
  });

  it.each([
    "CHANGE_ME_SESSION_SECRET_REPLACE_BEFORE_USE!!",
    "CHANGE_ME_SESSION_SECRET_REPLACE_BEFORE_USE!!",
  ])("refuses %s in production (it is public, cookies could be forged)", (value) => {
    process.env.HEIMDALL_SESSION_SECRET = value;
    process.env.NODE_ENV = "production";
    expect(() => sessionOptions()).toThrow(/published example value/);
  });

  it("caps session lifetime", () => {
    process.env.HEIMDALL_SESSION_SECRET = "b".repeat(32);
    expect(sessionOptions().ttl).toBe(12 * 60 * 60);
  });
});
