import { describe, expect, it, beforeEach } from "vitest";
import { resetDbForTests } from "@/lib/db/client";
import {
  createOrgAndAdmin,
  dismissAlertEvent,
  insertAlertEvent,
  isFingerprintMuted,
  listAlertEvents,
  muteAlertEvent,
  unmuteAlertEvent,
} from "@/lib/db/store";
import { alertFingerprint } from "./fingerprint";
import { newId } from "@/lib/ids";

describe("alarm mute / dismiss ops", () => {
  beforeEach(() => {
    resetDbForTests();
  });

  it("mutes by fingerprint and suppresses until unmute", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Mute Org",
      adminName: "Admin",
      email: "mute@example.com",
      password: "CorrectHorse1",
    });
    const fingerprint = alertFingerprint({
      orgId: org.id,
      ruleOrSource: "rule_1",
      agentOrAlarmId: "agt_1",
      metricOrName: "cpu_percent",
    });
    const eventId = newId("evt");
    await insertAlertEvent({
      id: eventId,
      orgId: org.id,
      ruleId: null,
      severity: "critical",
      message: "cpu high",
      fingerprint,
      payload: { agentId: "agt_1" },
    });

    const muted = await muteAlertEvent({
      orgId: org.id,
      eventId,
      minutes: 30,
    });
    expect(muted?.status).toBe("muted");
    expect(muted?.muted_until).toBeTruthy();
    expect(await isFingerprintMuted(org.id, fingerprint)).toBe(true);

    const open = await listAlertEvents(org.id, {
      status: "open_queue",
      limit: 20,
    });
    expect(open.some((e) => e.id === eventId && e.status === "muted")).toBe(
      true,
    );

    await unmuteAlertEvent({ orgId: org.id, eventId });
    expect(await isFingerprintMuted(org.id, fingerprint)).toBe(false);
  });

  it("dismiss removes from open queue but stays in history", async () => {
    const { org, user } = await createOrgAndAdmin({
      orgName: "Dismiss Org",
      adminName: "Admin",
      email: "dismiss@example.com",
      password: "CorrectHorse1",
    });
    const eventId = newId("evt");
    await insertAlertEvent({
      id: eventId,
      orgId: org.id,
      severity: "warning",
      message: "disk warn",
      payload: {},
    });

    await dismissAlertEvent({
      orgId: org.id,
      eventId,
      dismissedBy: user.id,
    });

    const open = await listAlertEvents(org.id, { status: "open_queue" });
    expect(open.find((e) => e.id === eventId)).toBeUndefined();

    const history = await listAlertEvents(org.id, { status: "dismissed" });
    expect(history.find((e) => e.id === eventId)?.status).toBe("dismissed");
  });

  it("reopens expired mutes on list", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Expire Org",
      adminName: "Admin",
      email: "expire@example.com",
      password: "CorrectHorse1",
    });
    const eventId = newId("evt");
    const fingerprint = alertFingerprint({
      orgId: org.id,
      ruleOrSource: "r",
      agentOrAlarmId: "a",
      metricOrName: "m",
    });
    await insertAlertEvent({
      id: eventId,
      orgId: org.id,
      severity: "warning",
      message: "x",
      fingerprint,
      payload: {},
    });
    const past = new Date(Date.now() - 60_000);
    await muteAlertEvent({
      orgId: org.id,
      eventId,
      minutes: 15,
      now: new Date(past.getTime() - 15 * 60_000),
    });

    const rows = await listAlertEvents(org.id, { status: "open" });
    expect(rows.find((e) => e.id === eventId)?.status).toBe("open");
    expect(await isFingerprintMuted(org.id, fingerprint)).toBe(false);
  });
});
