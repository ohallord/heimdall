import { afterEach, describe, expect, it, vi } from "vitest";
import {
  areAlertsPaused,
  setAlertsPaused,
} from "./pause";
import { enqueueAlertAndWait } from "./queue";

describe("alerts pause + async queue", () => {
  afterEach(() => {
    setAlertsPaused(false);
  });

  it("enqueueAlertAndWait returns paused when kill switch is on", async () => {
    setAlertsPaused(true);
    const result = await enqueueAlertAndWait({
      channels: [],
      payload: { subject: "x", message: "y" },
    });
    expect(result).toBe("paused");
    expect(areAlertsPaused()).toBe(true);
  });
});

describe("pause state across module instances", () => {
  afterEach(async () => {
    setAlertsPaused(false);
    vi.resetModules();
    (await import("./pause")).setAlertsPaused(false);
  });

  it("a toggle in one bundle copy is seen by another (route vs page/engine)", async () => {
    vi.resetModules();
    const routeCopy = await import("./pause");
    vi.resetModules();
    const pageCopy = await import("./pause");
    expect(routeCopy).not.toBe(pageCopy);
    routeCopy.setAlertsPaused(true);
    expect(pageCopy.areAlertsPaused()).toBe(true);
    routeCopy.setAlertsPaused(false);
    expect(pageCopy.areAlertsPaused()).toBe(false);
  });
});
