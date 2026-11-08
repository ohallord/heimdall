# Heimdall product security review (Phase 22, updated Phase 24 and 2026-11-07)

**Date:** 2026-10-22  
**Scope:** Hub authn/z, agent trust, integration ingest, secrets, multi-org boundaries, supply chain  
**Method:** STRIDE on trust boundaries + ASVS-informed checklist + `npm audit` / `govulncheck` evidence  
**Phase 15 mount correctness:** Reviewed — **not** a security finding (signal correctness / hostPath ops only). Remains deferred.

## Trust boundaries (STRIDE summary)

| Boundary | Spoofing | Tampering | Info disclosure | DoS | Elevation |
| --- | --- | --- | --- | --- | --- |
| Browser ↔ Hub | Password / OIDC; MFA for admins | Session cookie (`httpOnly`, `SameSite=lax`) | Session APIs org-scoped | Login/MFA rate limits; same-origin CSRF check (Phase 24) | RBAC matrix; MFA required to change MFA factors |
| Agent ↔ Hub | **Per-agent `hda_` secret** (Phase 24); legacy shared token during grace | Hostname rebind refused (409); revocable | Agent list requires session | Rate limit + body cap per token (Phase 24) | Secret bound to one agent id |
| UniFi / OTEL / runtime ↔ Hub | Integration token (hashed) | Token theft | Hint only on GET | Rate limit + body cap (Phase 24) | Org via token kind |
| Backup | Admin `settings:write` | Secretful export opt-in | Redact by default | — | Restore into session org |

## Findings and dispositions

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| F1 | P0 | Post-register agent APIs trusted body `agentId` only | **Fixed** — `authorizeAgentIngest` requires Bearer / `X-Heimdall-Token` and org bind |
| F2 | P0 | `GET /api/v1/agents` unauthenticated → all-org inventory | **Fixed** — `requireSession({ permission: "agents:read" })` + org scope; landing page gated |
| F3 | P0 | Hard-coded session secret + bootstrap default usable in production | **Partly fixed in Phase 22, completed 2026-11-07 (R1)** — Phase 22 only rejected unset/short secrets; the shipped Compose/Helm value passed that check. Now published values are refused and no deploy path ships one |
| F4 | P1 | No rate limits on login / MFA / ingest | **Fixed (Phase 24)** — in-memory limiter: login (ip+email, failures), MFA verify (user), register/ingest/webhooks (token), body size caps (413) |
| F5 | P1 | OIDC id_token decode without signature verify (userinfo preferred) | **Fixed (Phase 24)** — `jose` JWKS verification (alg allowlist, iss/aud/exp/nonce), PKCE S256, issuer match on discovery, IdP calls via `safeFetch` |
| F6 | P1 | TOTP / OIDC client_secret / SCM tokens plaintext at rest | **Fixed (Phase 24)** — AES-256-GCM `enc:v1:` sealing (`HEIMDALL_SECRET_KEY`), startup migration of legacy rows, fail-closed decrypt |
| F7 | P2 | No CSRF tokens (SameSite=lax only) | **Fixed (Phase 24)** — `mutating()` same-origin (Origin / Sec-Fetch-Site) check on 30 session-cookie routes; token-auth ingest routes exempt by design |
| F8 | P2 | Global `findUserByEmail` (org,email unique) | **Deferred** — multi-org SaaS hardening |
| F9 | P2 | In-process WebAuthn challenge store | **Deferred** — multi-instance |
| F10 | — | Phase 15 `/var` false missing mounts | **Not security** — remains deferred Implement |
| F11 | P0 | `POST /auth/mfa/totp/enroll` let an enrolled admin with unverified MFA replace their TOTP factor (password-only account takeover of MFA) | **Fixed (Phase 24)** — verified MFA required to enroll/replace; pending secret promoted only after code confirm; login runs a dummy bcrypt compare for unknown emails |
| F12 | P0 | Agent hostname rebind: a shared token could re-register any hostname and take over that agent identity | **Fixed (Phase 24); ingest gap closed 2026-11-07 (R4)** — per-agent secrets, 409 `hostname_in_use`, admin revoke / re-enroll, enrollment tokens with TTL / max uses; shared tokens deprecated (`HEIMDALL_LEGACY_TOKENS=off`) |
| F13 | P1 | SSRF via admin-configured URLs (IdP, webhooks, SCM APIs) incl. cloud-metadata | **Fixed (Phase 24)** — `safeFetch` (private/loopback/link-local blocked, DNS pinning, redirect re-validation, size/time caps), save-time `blocked_host`, `HEIMDALL_ALLOW_PRIVATE_HOSTS` allowlist |
| F14 | P1 | Well-known dev bootstrap token shipped in compose / Helm / agent default | **Fixed (Phase 24)** — removed everywhere; Compose and Helm require an operator value; dev token only with `HEIMDALL_DEV=1`; CI guard |
| F15 | P2 | Non-constant-time token comparison | **Fixed (Phase 24)** — `safeEqual` over SHA-256 digests |

## External-style review (2026-11-07)

A second pass read every route handler, the auth stack, outbound fetch, backup, the agent, installers, the chart, Compose and CI as an outside reviewer would. It found that some earlier dispositions were stronger on paper than in code (F3, F12). Each fix below has a regression test that failed before the change.

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| R1 | P0 | The example session secret shipped in Compose/Helm passed the `>=32` production check, so anyone could forge an admin cookie with MFA passed on a default install | **Fixed** — published values refused in production; Compose requires the env var; Helm generates and keeps one; CI guard extended |
| R2 | P0 | `POST /setup/org-admin` had no auth until the wizard finished: first visitor to a fresh hub became admin, repeatedly, and racing calls both won | **Fixed** — requires the hub bootstrap token; single atomic claim while no user exists |
| R3 | P0 | Wizard routes accepted a password-only admin after setup, and `setSetupStep()` reset `completed=false`, re-opening R2 on a live hub (MFA bypass) | **Fixed** — wizard routes 409 once complete; steps can no longer un-complete setup |
| R4 | P0 | Legacy enrollment/bootstrap tokens authenticated ingest for any agent in the org, including agents holding an `hda_` secret; spent single-use tokens still worked | **Fixed** — shared tokens only for agents without a secret; spent tokens refused |
| R5 | P1 | No security headers | **Fixed** — CSP (frame-ancestors, object-src, base-uri, form-action), XFO, nosniff, HSTS, Referrer/Permissions-Policy, COOP |
| R6 | P1 | OIDC linked an existing (admin) account by email without `email_verified=true`, and re-pointed accounts already linked | **Fixed** — verified email required to link; existing links never overwritten |
| R7 | P1 | Login/MFA limits counted only after the slow check, so parallel bursts bypassed them; TOTP codes replayable within the window; recovery codes double-spendable | **Fixed** — count first; last TOTP step stored; single-statement spend |
| R8 | P1 | Sessions were cookie-only for ~14 days: logout, deletion and demotion did not revoke them | **Fixed** — 12 h TTL, DB re-check per request, `session_version` bumped on logout |
| R9 | P1 | SMTP host bypassed the SSRF guard; backup restore skipped schema and URL validation and enabled restored IdPs | **Fixed** — SMTP checked at save and send; strict restore schema, SSRF check, IdPs restored disabled |
| R10 | P1 | Random tokens minted a fresh ingest rate-limit bucket per request; limiter map unbounded | **Fixed** — per-token buckets only for tokens that authenticated; map capped |
| R11 | P2 | OIDC token exchange posted `URLSearchParams` through `node:http` and threw (SSO broken); `AbortSignal` ignored | **Fixed** |
| R12 | P2 | Bearer tokens followed cross-origin redirects; NAT64/6to4/site-local/multicast/reserved ranges not blocked | **Fixed** |
| R13 | P2 | Export redaction missed webhook URLs and nested keys; 5xx bodies echoed driver/IdP error text; LIKE wildcards unescaped; `javascript:` advisory URLs stored; WebAuthn challenges never expired; any org could flip the hub-wide pause; OIDC `redirect_uri` from Host header | **Fixed** |
| R14 | P1 | Deploy defaults: Postgres password `heimdall` published on 0.0.0.0, plaintext in Helm; no container `securityContext`; host root mounted by default; unauthenticated OTLP receivers on 0.0.0.0; CI without `permissions:` and tag-pinned actions; installers accepted http hubs; token on argv with `set -x` | **Fixed** — see `docs/deploy.md` and `docs/runbooks/` for upgrade notes |

### Known limitations (accepted, documented)

- **Client IP without a proxy.** Next.js route handlers do not expose the socket address. Without `HEIMDALL_TRUST_PROXY`, per-IP buckets (login, setup, unauthenticated ingest) are shared by all clients, so one client can exhaust them. Run the hub behind a reverse proxy and set `HEIMDALL_TRUST_PROXY`.
- **Rate limits are per process** (multi-replica splits counters).
- **Sealed secrets carry no AAD.** A DB writer can swap two `enc:v1:` values between rows. Binding row identity needs a `v2` format and a re-seal migration; tracked.
- **WebAuthn is registration-only.** Sign-in verification for security keys is not implemented; admins who enrol only a key sign in with recovery codes. Enrol TOTP as well.
- **`/install.sh` without `HEIMDALL_PUBLIC_URL`** bakes the request Host into the script (sanitised, `no-store`). Set `HEIMDALL_PUBLIC_URL` in production.

## Hardening shipped in Phase 22

1. **Agent ingest auth** — `apps/hub/src/lib/agents/ingest-auth.ts` on heartbeat / metrics / logs / vulns.
2. **Agent client** — `handshake.Client` sends `Authorization: Bearer <token>` on post-register calls.
3. **Agent list** — session + org scope; public home registry no longer dumps fleet.
4. **Production secrets** — `sessionPassword()` and `resolveBootstrapToken()` fail closed in production.
5. **Docs** — this review + deploy agent-auth notes.

## Hardening shipped in Phase 24

1. **MFA and login** — verified MFA required to change factors; pending TOTP; login timing equalised; rate limits.
2. **OIDC** — JWT signature verification, PKCE, issuer match.
3. **Request protection** — rate limits, body caps, same-origin CSRF check.
4. **Agent credentials** — per-agent secrets, revocation, enrollment tokens, hostname-rebind refusal, legacy grace flag.
5. **No default token** — compose, Helm, agent, scripts; CI guard.
6. **Secrets at rest** — AES-256-GCM sealing, startup migration, chart-managed key.
7. **Outbound safety** — `safeFetch` on all admin-configured URLs, save-time validation.

Operator notes and recovery steps: `docs/runbooks/phase-24-hardening.md`.

## ASVS-informed checklist (selected)

| Area | Status |
| --- | --- |
| Password hashing (bcrypt) | OK |
| Session cookie flags | OK (`httpOnly`, `SameSite`, Secure derived) |
| MFA for admins | OK (TOTP / WebAuthn / recovery) |
| RBAC on dashboard APIs | OK (coarse roles) |
| Agent / integration token hashing | OK (SHA-256) |
| Backup redaction default | OK |
| Malicious input (Zod on many session APIs) | Partial — agent payloads still ad-hoc |
| Rate limiting | OK (in-memory, per process; multi-replica splits counters) |
| CSRF | OK (same-origin check; no per-form tokens) |
| Secrets at rest | OK (AES-256-GCM; key must be backed up) |
| SSRF | OK (`safeFetch` + allowlist) |

## Supply chain evidence

### Hub — `npm audit` (apps/hub)

Run: `npm audit` (2026-10-22)

| Summary | Count |
| --- | --- |
| critical | 2 |
| high | 7 |
| moderate | 3 |
| low / info | 0 |

Notable: **tinypool** (via **vitest**, devDependency) critical RCE gadgets; **braces** / **micromatch** via **tailwindcss@3** / eslint tooling. Fixes require breaking upgrades (`vitest@5`, `tailwindcss@4`).

**Disposition:** **Accepted for this phase** — issues are in **dev/build** tooling, not production hub runtime image path. Backlog: upgrade Vitest / Tailwind when scheduled. Lockfile patched to vitest **3.2.7** where non-breaking.

### Agent — `govulncheck ./...` (apps/agent)

Run: `govulncheck ./...` (2026-10-22) with current `go.mod` (`go 1.22`, `golang.org/x/net@v0.23.0`, `golang.org/x/text@v0.14.0` via client-go).

Result: **8 call-graph hits** in `golang.org/x/net` / `golang.org/x/text` (HTTP/2 / idna / norm), primarily through Docker HTTP client and k8s client-go.

Clearing them requires `golang.org/x/net` ≥ ~0.60 and a newer Go toolchain than CI’s `1.23.x` pin, plus a careful client-go bump.

**Disposition:** **Deferred** — tracked as supply-chain follow-up (bump CI Go + client-go together). Not treated as P0 product authz.

### Secret scan (repo)

Skimmed `.env.example`, Helm values, and code for hard-coded production credentials. The shipped bootstrap-token default was removed in Phase 24 (the dev token now needs `HEIMDALL_DEV=1`); the session-secret dev fallback is only used outside production, and production refuses it and every other value that has appeared in a shipped file (R1).

## Operator guidance

- Always set a random `HEIMDALL_SESSION_SECRET` (`openssl rand -hex 32`), `HEIMDALL_BOOTSTRAP_TOKEN`, `HEIMDALL_SECRET_KEY` and `HEIMDALL_PUBLIC_URL` in production. The first-run wizard asks for the bootstrap token.
- Upgrade **hub and agent together** after Phase 22 (Bearer ingest).
- Prefer minted wizard agent tokens over long-lived bootstrap tokens once setup is complete.
- Set `HEIMDALL_SECRET_KEY` (Compose) / keep the chart-managed key Secret backed up (Helm); set `HEIMDALL_TRUST_PROXY` only behind a proxy you control.
- Once every agent shows no `legacy token` badge, set `HEIMDALL_LEGACY_TOKENS=off`.
- Treat the hub as single-tenant self-host until the F8–F9 backlog lands.

## References

- Spec Kit: `docs/phases/phase-22-security-review/`, `docs/phases/phase-24-security-hardening/`
- Deploy: `docs/deploy.md` (Agent authentication)
- Architecture: `docs/architecture.md`
