import { beforeEach, describe, expect, it } from "vitest";
import * as OTPAuth from "otpauth";
import { resetDbForTests } from "./client";
import {
  createAgentToken,
  createOrgAndAdmin,
  createUser,
  findUserByEmail,
  isSetupComplete,
  listAlertChannels,
  markMfaEnrolled,
  markSetupComplete,
  registerAgentPersistent,
  replaceRecoveryCodes,
  consumeRecoveryCode,
  setUserTotpSecret,
  upsertAlertChannel,
  ensureDefaultThresholdRule,
} from "./store";
import { can } from "@/lib/rbac/permissions";
import { verifyTotp } from "@/lib/mfa/totp";
import { evaluateRule } from "@/lib/alerts/engine";

describe("wizard + auth + alerts persistence", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  it("runs org/admin wizard foundation and RBAC roles", async () => {
    expect(await isSetupComplete()).toBe(false);
    const { org, user } = await createOrgAndAdmin({
      orgName: "North Ops",
      adminName: "Ada Admin",
      email: "ada@example.com",
      password: "CorrectHorse1",
    });
    expect(org.name).toBe("North Ops");
    expect(user.role).toBe("admin");
    expect(can(user.role, "setup:run")).toBe(true);

    const operator = await createUser({
      orgId: org.id,
      email: "ops@example.com",
      name: "Ollie",
      password: "CorrectHorse1",
      role: "operator",
    });
    const viewer = await createUser({
      orgId: org.id,
      email: "view@example.com",
      name: "Vera",
      password: "CorrectHorse1",
      role: "viewer",
    });
    expect(can(operator.role, "agents:write")).toBe(true);
    expect(can(viewer.role, "agents:write")).toBe(false);
    expect((await findUserByEmail("ada@example.com"))?.id).toBe(user.id);
  });

  it("enrolls TOTP MFA and consumes recovery codes", async () => {
    const { user } = await createOrgAndAdmin({
      orgName: "MFA Org",
      adminName: "Admin",
      email: "mfa@example.com",
      password: "CorrectHorse1",
    });

    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    await setUserTotpSecret(user.id, secret);
    const totp = new OTPAuth.TOTP({
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    expect(verifyTotp(secret, totp.generate())).toBe(true);
    await markMfaEnrolled(user.id);
    const codes = await replaceRecoveryCodes(user.id);
    expect(codes.length).toBe(10);
    expect(await consumeRecoveryCode(user.id, codes[0])).toBe(true);
    expect(await consumeRecoveryCode(user.id, codes[0])).toBe(false);
  });

  it("persists alert channels, threshold rule, and agent token handshake", async () => {
    const { org, user } = await createOrgAndAdmin({
      orgName: "Alert Org",
      adminName: "Admin",
      email: "alerts@example.com",
      password: "CorrectHorse1",
    });

    await upsertAlertChannel({
      orgId: org.id,
      kind: "smtp",
      config: {
        host: "mail.example",
        port: 587,
        from: "heimdall@example.com",
        to: "oncall@example.com",
      },
    });
    await upsertAlertChannel({
      orgId: org.id,
      kind: "slack",
      config: { url: "https://hooks.example/slack" },
    });
    await upsertAlertChannel({
      orgId: org.id,
      kind: "sms",
      enabled: true,
      config: {
        provider: "twilio-compatible",
        accountSid: "ACtest",
        authToken: "tok",
        from: "+1000",
        to: "+2000",
      },
    });

    const channels = await listAlertChannels(org.id);
    expect(channels.map((c) => c.kind).sort()).toEqual(["slack", "sms", "smtp"]);

    const rule = await ensureDefaultThresholdRule(org.id);
    expect(
      evaluateRule(rule, { metric: "agent_offline_minutes", value: 10 }),
    ).toBe(true);

    const { token } = await createAgentToken({
      orgId: org.id,
      name: "first",
      createdBy: user.id,
    });
    const registered = await registerAgentPersistent({
      token,
      hostname: "edge-42",
      version: "0.1.0",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.agent.hostname).toBe("edge-42");

    await markMfaEnrolled(user.id);
    await markSetupComplete(org.id);
    expect(await isSetupComplete()).toBe(true);
  });
});
