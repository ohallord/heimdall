# Heimdall security review

**Last updated:** 2026-10-30
**Scope:** hub authentication and authorization, agent trust, integration ingest, secrets, multi-org boundaries, supply chain
**Method:** STRIDE on each trust boundary, an ASVS-informed checklist, and `npm audit` / `govulncheck` evidence

For how the controls are designed, see the [security model](design/security-model.md). To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Trust boundaries (STRIDE summary)

| Boundary | Spoofing | Tampering | Info disclosure | DoS | Elevation |
| --- | --- | --- | --- | --- | --- |
| Browser ↔ Hub | Password or OIDC; MFA for admins | Session cookie (`httpOnly`, `SameSite=lax`) | Session APIs scoped to the org | Login and MFA rate limits; same-origin CSRF check | RBAC matrix; verified MFA required to change MFA factors |
| Agent ↔ Hub | Per-agent `hda_` secret; legacy shared token only during the grace period | Hostname rebind refused (409); revocable | Agent list requires a session | Rate limit and body cap per token | Secret bound to one agent ID |
| UniFi / OTel / runtime ↔ Hub | Integration token (hashed) | Token theft | Only a hint on GET | Rate limit and body cap | Org determined by the token's kind |
| Backup | Admin `settings:write` | Export with secrets is opt-in | Redacted by default | — | Restore only into the session's org |

## Findings and dispositions

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| F1 | P0 | After registration, agent APIs trusted the `agentId` in the body | **Fixed.** `authorizeAgentIngest` requires `Bearer` or `X-Heimdall-Token` and binds to the org |
| F2 | P0 | `GET /api/v1/agents` was unauthenticated and returned every org's inventory | **Fixed.** `requireSession({ permission: "agents:read" })` plus org scoping; landing page gated |
| F3 | P0 | Hard-coded session secret and bootstrap default usable in production | **Fixed.** Fails closed when `NODE_ENV=production` and the value is unset or weak |
| F4 | P1 | No rate limits on login, MFA or ingest | **Fixed.** In-memory limiter: login (IP + email, failures), MFA verify (user), register, ingest and webhooks (token); body caps (413) |
| F5 | P1 | OIDC ID token decoded without signature verification | **Fixed.** `jose` JWKS verification (alg allowlist, `iss`/`aud`/`exp`/`nonce`), PKCE S256, issuer match on discovery, IdP calls through `safeFetch` |
| F6 | P1 | TOTP seeds, OIDC client secrets and SCM tokens stored in plaintext | **Fixed.** AES-256-GCM `enc:v1:` sealing (`HEIMDALL_SECRET_KEY`), startup migration of legacy rows, fail-closed decrypt |
| F7 | P2 | No CSRF protection beyond `SameSite=lax` | **Fixed.** `mutating()` same-origin check (Origin / Sec-Fetch-Site) on every session-cookie mutating route; token-auth ingest routes exempt by design |
| F8 | P2 | `findUserByEmail` is global (unique key is org + email) | **Deferred.** Matters only for multi-org SaaS |
| F9 | P2 | WebAuthn challenge store is in process | **Deferred.** Matters only for multiple hub replicas |
| F11 | P0 | `POST /auth/mfa/totp/enroll` let a password-only session replace an enrolled admin's TOTP factor (MFA takeover) | **Fixed.** Verified MFA required to enroll or replace; the pending secret is promoted only after a code confirms it; login runs a dummy bcrypt compare for unknown emails |
| F12 | P0 | A shared token could re-register any hostname and take over that agent's identity | **Fixed.** Per-agent secrets, `409 hostname_in_use`, admin revoke and re-enroll, enrollment tokens with TTL and max uses; shared tokens deprecated (`HEIMDALL_LEGACY_TOKENS=off`) |
| F13 | P1 | SSRF through admin-configured URLs (IdP, webhooks, SCM APIs), including cloud metadata | **Fixed.** `safeFetch` (private, loopback and link-local blocked, DNS pinning, redirects re-validated, size and time caps), save-time `blocked_host`, `HEIMDALL_ALLOW_PRIVATE_HOSTS` allowlist |
| F14 | P1 | A well-known dev bootstrap token shipped in Compose, Helm and the agent default | **Fixed.** Removed everywhere; Compose and Helm require an operator value; dev token only with `HEIMDALL_DEV=1`; CI guard |
| F15 | P2 | Token comparison was not constant time | **Fixed.** `safeEqual` over SHA-256 digests |

(F10 was a false-positive mount alert, reviewed and classified as not a security issue.)

## ASVS-informed checklist (selected)

| Area | Status |
| --- | --- |
| Password hashing (bcrypt) | OK |
| Session cookie flags | OK (`httpOnly`, `SameSite`, `Secure` derived from the public URL) |
| MFA for admins | OK (TOTP, WebAuthn, recovery codes) |
| RBAC on dashboard APIs | OK (coarse roles) |
| Agent and integration token hashing | OK (SHA-256) |
| Backup redaction by default | OK |
| Input validation | Partial. Zod on session APIs; agent payloads still validated ad hoc |
| Rate limiting | OK (in memory, per process; several replicas split the counters) |
| CSRF | OK (same-origin check; no per-form tokens) |
| Secrets at rest | OK (AES-256-GCM; the key must be backed up) |
| SSRF | OK (`safeFetch` plus allowlist) |

## Supply chain

### Hub: `npm audit` (`apps/hub`, 2026-10-22)

| Severity | Count |
| --- | --- |
| critical | 2 |
| high | 7 |
| moderate | 3 |

Notable: **tinypool** (via **vitest**, a dev dependency) and **braces** / **micromatch** (via **tailwindcss@3** and eslint tooling). Fixing them requires major upgrades (`vitest`, `tailwindcss@4`).

**Disposition: accepted for now.** These are in dev and build tooling, not in the production hub image. Vitest is patched to 3.2.7 where possible, and the major upgrades are on the backlog.

### Agent: `govulncheck ./...` (`apps/agent`, 2026-10-22)

**8 call-graph hits** in `golang.org/x/net` and `golang.org/x/text` (HTTP/2, idna, norm), mainly through the Docker HTTP client and client-go. Clearing them needs `golang.org/x/net` ≥ ~0.60, a newer Go toolchain than CI's 1.23 pin, and a careful client-go upgrade.

**Disposition: deferred.** Tracked as a supply-chain follow-up (upgrade CI Go and client-go together).

### Secret scan

Reviewed `.env.example`, Helm values and source for hard-coded production credentials. The shipped bootstrap default is gone (the dev token needs `HEIMDALL_DEV=1`). The Compose file still sets a local-only session secret and Postgres password; production deployments must override them. Production code paths refuse weak session secrets (F3).

## Operator guidance

- Always set `HEIMDALL_SESSION_SECRET` (≥ 32 characters), `HEIMDALL_BOOTSTRAP_TOKEN` and `HEIMDALL_SECRET_KEY` in production, and override the Compose defaults.
- Upgrade the hub first, then agents.
- Prefer short-lived enrollment tokens. Disable the bootstrap token after setup.
- Back up `HEIMDALL_SECRET_KEY` (Compose) or the chart-managed key Secret (Helm). Set `HEIMDALL_TRUST_PROXY` only behind a proxy you control.
- Once no agent shows a `legacy token` badge, set `HEIMDALL_LEGACY_TOKENS=off`.
- Treat the hub as single-tenant and single-replica until F8 and F9 are addressed.

Symptoms and fixes for these controls: [runbooks/security-hardening.md](runbooks/security-hardening.md).
