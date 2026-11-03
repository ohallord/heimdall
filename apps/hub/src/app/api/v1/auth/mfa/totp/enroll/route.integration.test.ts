import * as OTPAuth from "otpauth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = {
  isLoggedIn: true,
  userId: "",
  role: "admin" as const,
  mfaVerified: false,
  save: vi.fn(async () => {}),
};

vi.mock("@/lib/auth/session", () => ({ getSession: async () => session }));

import { resetDbForTests } from "@/lib/db/client";
import {
  createOrgAndAdmin,
  findUserById,
  markMfaEnrolled,
  setUserTotpSecret,
} from "@/lib/db/store";
import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://hub.test/api/v1/auth/mfa/totp/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("totp/enroll MFA guard", () => {
  let userId: string;

  beforeEach(async () => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    const { user } = await createOrgAndAdmin({
      orgName: "Org",
      adminName: "Ada",
      email: "ada@example.com",
      password: "CorrectHorse1",
    });
    userId = user.id;
    await setUserTotpSecret(userId, "ORIGINALSECRET");
    await markMfaEnrolled(userId);
    session.userId = userId;
    session.mfaVerified = false;
  });

  it.each(["start", "confirm"])(
    "403 mfa_required for enrolled admin without mfaVerified (%s)",
    async (action) => {
      const res = await POST(req({ action, token: "123456", secret: "ATTACKER" }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "mfa_required" });
      expect((await findUserById(userId))?.totp_secret).toBe("ORIGINALSECRET");
    },
  );

  it("verified admin: start holds pending, confirm promotes; client secret ignored", async () => {
    session.mfaVerified = true;
    const start = await POST(req({ action: "start" }));
    const { secret } = await start.json();
    let u = await findUserById(userId);
    expect(u?.totp_secret).toBe("ORIGINALSECRET");
    expect(u?.totp_pending).toBe(secret);

    const bad = await POST(req({ action: "confirm", token: "000000", secret: "ATTACKER" }));
    expect(bad.status).toBe(400);
    expect((await findUserById(userId))?.totp_secret).toBe("ORIGINALSECRET");

    const token = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
    const ok = await POST(req({ action: "confirm", token }));
    expect(ok.status).toBe(200);
    u = await findUserById(userId);
    expect(u?.totp_secret).toBe(secret);
    expect(u?.totp_pending).toBeNull();
  });
});
