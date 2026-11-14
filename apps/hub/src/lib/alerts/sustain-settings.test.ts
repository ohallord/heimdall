import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin } from "@/lib/db/store";
import {
  DEFAULT_ALERT_SUSTAIN_SECONDS,
  MAX_ALERT_SUSTAIN_SECONDS,
  getAlertSustainSeconds,
  setAlertSustainSeconds,
} from "./sustain-settings";

describe("alert sustain setting", () => {
  let orgId = "";
  beforeEach(async () => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    delete process.env.HEIMDALL_ALERT_SUSTAIN_DEFAULT_SECONDS;
    resetDbForTests();
    ({ org: { id: orgId } } = await createOrgAndAdmin({
      orgName: "Sustain Org",
      adminName: "Admin",
      email: "sustain@example.com",
      password: "CorrectHorse1",
    }));
  });
  afterEach(() => {
    process.env.HEIMDALL_ALERT_SUSTAIN_DEFAULT_SECONDS = "0";
  });

  it("defaults to 120 seconds", async () => {
    expect(DEFAULT_ALERT_SUSTAIN_SECONDS).toBe(120);
    expect(await getAlertSustainSeconds(orgId)).toBe(120);
  });

  it("an env default applies until the org saves its own value", async () => {
    process.env.HEIMDALL_ALERT_SUSTAIN_DEFAULT_SECONDS = "30";
    expect(await getAlertSustainSeconds(orgId)).toBe(30);
    await setAlertSustainSeconds(orgId, 45);
    expect(await getAlertSustainSeconds(orgId)).toBe(45);
  });

  it("stores 0 (fire immediately) and clamps to 0..max", async () => {
    expect(await setAlertSustainSeconds(orgId, 0)).toBe(0);
    expect(await getAlertSustainSeconds(orgId)).toBe(0);
    expect(await setAlertSustainSeconds(orgId, 90.4)).toBe(90);
    expect(await setAlertSustainSeconds(orgId, 999_999)).toBe(MAX_ALERT_SUSTAIN_SECONDS);
    expect(await setAlertSustainSeconds(orgId, -5)).toBe(0);
  });
});
