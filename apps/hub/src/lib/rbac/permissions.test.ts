import { describe, expect, it } from "vitest";
import { assertCan, can, roles } from "./permissions";

describe("RBAC matrix", () => {
  it("exposes three roles", () => {
    expect(roles()).toEqual(["admin", "operator", "viewer"]);
  });

  it("allows admin setup and settings", () => {
    expect(can("admin", "setup:run")).toBe(true);
    expect(can("admin", "settings:write")).toBe(true);
    expect(can("admin", "users:invite")).toBe(true);
  });

  it("allows operator agent/alert writes but not setup", () => {
    expect(can("operator", "agents:write")).toBe(true);
    expect(can("operator", "alerts:write")).toBe(true);
    expect(can("operator", "setup:run")).toBe(false);
    expect(can("operator", "users:invite")).toBe(false);
  });

  it("keeps viewer read-only", () => {
    expect(can("viewer", "agents:read")).toBe(true);
    expect(can("viewer", "alerts:read")).toBe(true);
    expect(can("viewer", "agents:write")).toBe(false);
    expect(can("viewer", "alerts:write")).toBe(false);
    expect(() => assertCan("viewer", "settings:write")).toThrow(/forbidden/);
  });
});
