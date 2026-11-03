import { beforeEach, describe, expect, it, vi } from "vitest";

// Route tests drive requireSession through this mutable fake (RBAC still enforced via `can`).
const fakeSession = vi.hoisted(() => ({
  value: null as null | { userId: string; orgId: string; role: "admin" | "operator" | "viewer" },
}));
vi.mock("@/lib/auth/session", async (orig) => {
  const real = await orig<typeof import("@/lib/auth/session")>();
  const { can } = await import("@/lib/rbac/permissions");
  return {
    ...real,
    requireSession: async (opts?: { permission?: import("@/lib/rbac/permissions").Permission }) => {
      const s = fakeSession.value;
      if (!s) throw Object.assign(new Error("unauthorized"), { status: 401 });
      if (opts?.permission && !can(s.role, opts.permission)) {
        throw Object.assign(new Error("forbidden"), { status: 403 });
      }
      return { ...s, isLoggedIn: true, mfaVerified: true };
    },
  };
});

import { resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin, registerAgentPersistent } from "@/lib/db/store";
import { authorizeAgentIngest } from "@/lib/agents/ingest-auth";
import {
  bootstrapStatus,
  disableBootstrapToken,
  matchesBootstrapToken,
  resetBootstrapCache,
  revertBootstrapToEnv,
  rotateBootstrapToken,
} from "./bootstrap";
import { GET as bootstrapGet, POST as bootstrapPost } from "@/app/api/v1/admin/bootstrap-token/route";
import { POST as mintPost } from "@/app/api/v1/agents/tokens/route";
import { POST as replacePost } from "@/app/api/v1/agents/tokens/[tokenId]/replace/route";

const ENV_TOKEN = "env-bootstrap-token-0123456789abcdef";

async function adminOrg(email = "boot@example.com") {
  const { org, user } = await createOrgAndAdmin({
    orgName: `Org ${email}`,
    adminName: "Admin",
    email,
    password: "CorrectHorse1",
  });
  return { orgId: org.id, userId: user.id };
}

const register = (token: string, hostname: string) =>
  registerAgentPersistent({ token, hostname, version: "1.0.0" });

const ingestReq = (token: string) =>
  new Request("http://hub.test/api/v1/agents/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

const json = (body: unknown) =>
  new Request("http://hub.test/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  process.env.HEIMDALL_DB_DRIVER = "pglite";
  delete process.env.DATABASE_URL;
  delete process.env.HEIMDALL_DEV;
  delete process.env.HEIMDALL_PUBLIC_URL;
  process.env.HEIMDALL_BOOTSTRAP_TOKEN = ENV_TOKEN;
  resetDbForTests();
  resetBootstrapCache();
  fakeSession.value = null;
});

describe("bootstrap token modes", () => {
  it("env mode accepts the env token and reports its source", async () => {
    await adminOrg();
    expect(await matchesBootstrapToken(ENV_TOKEN)).toBe(true);
    expect(await matchesBootstrapToken("nope")).toBe(false);
    const s = await bootstrapStatus();
    expect(s).toMatchObject({ mode: "env", source: "env", weak: false, active: true });
    expect((await register(ENV_TOKEN, "h-env")).ok).toBe(true);
  });

  it("flags the dev default and short tokens as weak", async () => {
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "heimdall-dev-token";
    expect((await bootstrapStatus()).weak).toBe(true);
    resetBootstrapCache();
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "short-token";
    expect((await bootstrapStatus()).weak).toBe(true);
  });

  it("rotate: only the new token works; registered agents keep their secret", async () => {
    const { userId } = await adminOrg();
    const before = await register(ENV_TOKEN, "h-old");
    expect(before.ok).toBe(true);
    const secret = before.ok ? before.agentSecret! : "";
    const agentId = before.ok ? before.agent.id : "";

    const { token } = await rotateBootstrapToken(userId);
    expect(token).toMatch(/^hdb_[A-Za-z0-9_-]{40,}$/);
    expect(await bootstrapStatus()).toMatchObject({ mode: "rotated", source: "database", weak: false });

    const old = await register(ENV_TOKEN, "h-new-1");
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.status).toBe(401);
    expect((await register(token, "h-new-2")).ok).toBe(true);

    // legacy shared-token ingest with the old env token is refused too
    expect((await authorizeAgentIngest(ingestReq(ENV_TOKEN), agentId)).ok).toBe(false);
    // the already-registered agent is unaffected
    expect((await authorizeAgentIngest(ingestReq(secret), agentId)).ok).toBe(true);
  });

  it("disable refuses every bootstrap token but enrollment tokens still work; revert restores env", async () => {
    const { userId, orgId } = await adminOrg();
    const reg = await register(ENV_TOKEN, "h-pre");
    const secret = reg.ok ? reg.agentSecret! : "";
    const agentId = reg.ok ? reg.agent.id : "";

    await disableBootstrapToken(userId);
    expect(await bootstrapStatus()).toMatchObject({ mode: "disabled", active: false, weak: false });
    expect((await register(ENV_TOKEN, "h-x")).ok).toBe(false);
    expect((await authorizeAgentIngest(ingestReq(secret), agentId)).ok).toBe(true);

    const { createAgentToken } = await import("@/lib/db/store");
    const { token } = await createAgentToken({ orgId, name: "t" });
    expect((await register(token, "h-enrolled")).ok).toBe(true);

    await revertBootstrapToEnv(userId);
    expect((await bootstrapStatus()).mode).toBe("env");
    expect((await register(ENV_TOKEN, "h-back")).ok).toBe(true);
  });
});

describe("bootstrap token admin route", () => {
  it("lets the bootstrap-org admin rotate and returns a helm command, never the hash", async () => {
    const { orgId, userId } = await adminOrg();
    fakeSession.value = { userId, orgId, role: "admin" };
    const status = await (await bootstrapGet()).json();
    expect(status.mode).toBe("env");
    expect(status.canManage).toBe(true);

    const res = await bootstrapPost(json({ action: "rotate" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toMatch(/^hdb_/);
    expect(body.helmCommand).toContain("hub.env.HEIMDALL_BOOTSTRAP_TOKEN=");
    expect(body.helmCommand).toContain(body.token);
    expect(JSON.stringify(body)).not.toContain("token_hash");
    expect(body.status.mode).toBe("rotated");
  });

  it("refuses operators and admins of other orgs", async () => {
    const { orgId, userId } = await adminOrg("first@example.com");
    const other = await adminOrg("second@example.com");
    fakeSession.value = { userId, orgId, role: "operator" };
    expect((await bootstrapPost(json({ action: "disable" }))).status).toBe(403);
    fakeSession.value = { userId: other.userId, orgId: other.orgId, role: "admin" };
    expect((await bootstrapPost(json({ action: "disable" }))).status).toBe(403);
    expect((await (await bootstrapGet()).json()).canManage).toBe(false);
    fakeSession.value = { userId, orgId, role: "admin" };
    expect((await bootstrapPost(json({ action: "bogus" }))).status).toBe(400);
    expect((await bootstrapStatus()).mode).toBe("env");
  });
});

describe("enrollment token routes", () => {
  it("mint returns copy-ready install commands", async () => {
    process.env.HEIMDALL_PUBLIC_URL = "https://heimdall.example.com";
    const { orgId, userId } = await adminOrg();
    fakeSession.value = { userId, orgId, role: "operator" };
    const res = await mintPost(json({ name: "web-01", ttlHours: 24, maxUses: 1 }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toMatch(/^hdt_/);
    // Default commands prompt, so the token never lands in sudo's journal entry.
    expect(body.installCommands.agent).toBe(
      "curl -fsSL https://heimdall.example.com/install.sh | sudo bash",
    );
    expect(body.installCommands.agentWithOtel).toBe(
      "curl -fsSL https://heimdall.example.com/install.sh | sudo OTEL=1 bash",
    );
    expect(body.installCommands.agent).not.toContain(body.token);
    expect(body.installCommands.agentNonInteractive).toBe(
      `curl -fsSL https://heimdall.example.com/install.sh | sudo TOKEN=${body.token} bash`,
    );
  });

  it("replace revokes the old token and mints one with the same settings", async () => {
    const { orgId, userId } = await adminOrg();
    fakeSession.value = { userId, orgId, role: "admin" };
    const first = await (await mintPost(json({ name: "db-01", ttlHours: 168, maxUses: 3 }))).json();

    const res = await replacePost(json({}), { params: Promise.resolve({ tokenId: first.id }) });
    expect(res.status).toBe(201);
    const next = await res.json();
    expect(next.id).not.toBe(first.id);
    expect(next.name).toBe("db-01");
    expect(next.maxUses).toBe(3);
    expect(Date.parse(next.expiresAt) - Date.now()).toBeGreaterThan(167 * 3_600_000);
    expect(next.installCommands.agentNonInteractive).toContain(next.token);

    expect((await register(first.token, "h-old-tok")).ok).toBe(false);
    expect((await register(next.token, "h-new-tok")).ok).toBe(true);

    const other = await adminOrg("other@example.com");
    fakeSession.value = { userId: other.userId, orgId: other.orgId, role: "admin" };
    expect(
      (await replacePost(json({}), { params: Promise.resolve({ tokenId: next.id }) })).status,
    ).toBe(404);
  });
});

describe("restart after the enrollment/bootstrap token is gone", () => {
  // The agent re-registers on every start with its configured token + saved secret.
  const reRegister = (token: string, hostname: string, agentSecret: string) =>
    registerAgentPersistent({ token, hostname, version: "1.0.1", agentSecret });

  it("an installed agent restarts after its enrollment token is revoked or expired", async () => {
    const { orgId } = await adminOrg();
    const { createAgentToken, revokeAgentToken } = await import("@/lib/db/store");

    const revoked = await createAgentToken({ orgId, name: "r", maxUses: 1 });
    const a = await register(revoked.token, "h-revoked");
    expect(a.ok).toBe(true);
    await revokeAgentToken(revoked.row.id, orgId);
    const again = await reRegister(revoked.token, "h-revoked", a.ok ? a.agentSecret! : "");
    expect(again.ok).toBe(true);
    if (again.ok && a.ok) expect(again.agent.id).toBe(a.agent.id);

    const expired = await createAgentToken({ orgId, name: "e", expiresAt: new Date(Date.now() + 60_000) });
    const b = await register(expired.token, "h-expired");
    expect(b.ok).toBe(true);
    const { getDb } = await import("@/lib/db/client");
    await (await getDb()).query(`UPDATE agent_tokens SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [expired.row.id]);
    expect((await reRegister(expired.token, "h-expired", b.ok ? b.agentSecret! : "")).ok).toBe(true);

    // without its secret, a dead token still gets nothing
    const stranger = await reRegister(revoked.token, "h-stranger", "hda_not-a-real-secret");
    expect(stranger.ok).toBe(false);
  });

  it("the in-cluster agent restarts after a bootstrap rotate or disable", async () => {
    const { userId } = await adminOrg();
    const a = await register(ENV_TOKEN, "h-incluster");
    const secret = a.ok ? a.agentSecret! : "";
    await rotateBootstrapToken(userId);
    expect((await reRegister(ENV_TOKEN, "h-incluster", secret)).ok).toBe(true);
    await disableBootstrapToken(userId);
    expect((await reRegister(ENV_TOKEN, "h-incluster", secret)).ok).toBe(true);
  });

  it("a revoked agent stays revoked even with its secret", async () => {
    await adminOrg();
    const a = await register(ENV_TOKEN, "h-gone");
    const { getDb } = await import("@/lib/db/client");
    await (await getDb()).query(`UPDATE agents SET revoked_at = NOW() WHERE hostname = 'h-gone'`);
    const res = await reRegister("whatever", "h-gone", a.ok ? a.agentSecret! : "");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });
});
