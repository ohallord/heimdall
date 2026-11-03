import { afterEach, describe, expect, it } from "vitest";
import { resolveBootstrapToken } from "./store";

describe("resolveBootstrapToken", () => {
  const prevToken = process.env.HEIMDALL_BOOTSTRAP_TOKEN;
  const prevNode = process.env.NODE_ENV;
  const prevDev = process.env.HEIMDALL_DEV;

  afterEach(() => {
    if (prevToken === undefined) delete process.env.HEIMDALL_BOOTSTRAP_TOKEN;
    else process.env.HEIMDALL_BOOTSTRAP_TOKEN = prevToken;
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
    if (prevDev === undefined) delete process.env.HEIMDALL_DEV;
    else process.env.HEIMDALL_DEV = prevDev;
  });

  it("returns env when set", () => {
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "custom-token";
    expect(resolveBootstrapToken()).toBe("custom-token");
  });

  it("returns null when unset and not in dev mode", () => {
    delete process.env.HEIMDALL_BOOTSTRAP_TOKEN;
    delete process.env.HEIMDALL_DEV;
    process.env.NODE_ENV = "test";
    expect(resolveBootstrapToken()).toBeNull();
  });

  it("uses the dev token only with HEIMDALL_DEV=1 outside production", () => {
    delete process.env.HEIMDALL_BOOTSTRAP_TOKEN;
    process.env.HEIMDALL_DEV = "1";
    process.env.NODE_ENV = "development";
    expect(resolveBootstrapToken()).toBe("heimdall-dev-token");
  });

  it("ignores HEIMDALL_DEV in production", () => {
    delete process.env.HEIMDALL_BOOTSTRAP_TOKEN;
    process.env.HEIMDALL_DEV = "1";
    process.env.NODE_ENV = "production";
    expect(resolveBootstrapToken()).toBeNull();
  });

  it("returns null in production when unset", () => {
    delete process.env.HEIMDALL_BOOTSTRAP_TOKEN;
    process.env.NODE_ENV = "production";
    expect(resolveBootstrapToken()).toBeNull();
  });
});
