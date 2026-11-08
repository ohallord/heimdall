# Security model

This document describes how Heimdall is designed to be secure. For the formal review, findings and their dispositions, see [security-review.md](../security-review.md).

## Assets

1. **Control of the console**: admin sessions can change alerting, SSO and agent trust.
2. **Credentials Heimdall holds**: SMTP passwords, Slack, Discord and Twilio secrets, GitHub and GitLab tokens, OIDC client secrets, TOTP seeds.
3. **Agent identities**: a forged agent can inject false metrics or hide real ones.
4. **Collected data**: logs (which may contain sensitive lines), findings, and the topology of your estate.

## Trust boundaries

```
 Browser ──(session cookie, CSRF origin check)──┐
 Agents  ──(per-agent hda_ secret)──────────────┤
 OTel / UniFi / Falco ──(hdo_/hdu_/hdr_ token)──┼──► Hub ──► Postgres (secrets sealed with HEIMDALL_SECRET_KEY)
 IdP ◄──(OIDC + PKCE, JWKS verify)──────────────┤
 Webhooks / SCM APIs ◄──(safeFetch SSRF guard)──┘
```

## Credentials

| Credential | Format | Stored as | Rotation |
| --- | --- | --- | --- |
| User password | — | bcrypt | (no self-service change yet) |
| Recovery codes | — | hash, single use | Re-enroll MFA |
| TOTP seed | — | `enc:v1:` AES-256-GCM | Re-enroll (requires verified MFA) |
| Session | iron-session sealed cookie | client side | Change `HEIMDALL_SESSION_SECRET` (logs everyone out) |
| Enrollment token | `hdt_…` | SHA-256 + hint | TTL, max uses, replace, revoke |
| Bootstrap token | env or `hdb_…` | env, or SHA-256 in `hub_bootstrap` | Rotate or disable in UI |
| Agent secret | `hda_…` | SHA-256 (hub), file 0600 (agent) | Revoke / Re-enroll |
| Integration tokens | `hdo_` `hdu_` `hdr_` | SHA-256, one per kind per org | Rotate in UI (old one dies immediately) |
| Channel, SCM, OIDC secrets | — | `enc:v1:` AES-256-GCM | Re-enter in UI |

Every token comparison hashes both sides with SHA-256 and compares in constant time (`safeEqual`). Plaintext tokens are shown exactly once.

## Authentication and authorization

- **Users.** bcrypt passwords. Login runs a dummy bcrypt compare for unknown emails, so response timing does not reveal which accounts exist. MFA uses TOTP, WebAuthn passkeys, or single-use recovery codes. Changing MFA factors requires a session that has already passed MFA (fixes F11). Login and MFA attempts are counted before the check, so parallel bursts cannot exceed the limit; a TOTP code works once, and recovery codes are spent atomically.
- **SSO.** OIDC discovery with an issuer match, PKCE S256, nonce, and ID token signature verification against the IdP JWKS (alg allowlist, `iss`/`aud`/`exp` checks). New users get `viewer`. An existing account is linked only when the IdP asserts `email_verified=true`, and an account already linked to another subject is never re-pointed. Admins with MFA still verify TOTP after SSO.
- **Sessions.** `httpOnly`, `SameSite=lax`. `Secure` is derived from `HEIMDALL_PUBLIC_URL` (override with `HEIMDALL_COOKIE_SECURE`). The hub refuses to start in production without a session secret of at least 32 characters, or with one that has appeared in a published file. Sessions last 12 hours and are re-checked against the database on every request: logout (`session_version`), deletion and demotion take effect at once.
- **First-run setup.** Creating the first admin requires the bootstrap token and succeeds once. Wizard routes refuse once setup is complete.
- **Response headers.** CSP (`frame-ancestors 'none'`, `object-src 'none'`, `base-uri`/`form-action 'self'`), `X-Frame-Options: DENY`, `nosniff`, HSTS, Referrer-Policy, Permissions-Policy. Unexpected errors return `internal_error`; details stay in the server log.
- **RBAC.** A fixed matrix of three roles (viewer, operator, admin) over nine permissions (`lib/rbac/permissions.ts`). Every session route calls `requireSession({ permission })`, and every query is scoped to the session's org.
- **CSRF.** Mutating session routes require a same-origin `Origin` or `Sec-Fetch-Site`. Token-authenticated ingest routes are exempt because they never use cookies.
- **Agents.** Per-agent secrets bound to one agent ID. A hostname cannot be rebound by someone holding a shared token (`409`). Revocation is immediate.

## Abuse resistance

| Control | Default |
| --- | --- |
| Failed-login limit (IP + email) | 10 per 15 min |
| MFA failure limit (user) | 5 per 5 min |
| Ingest limit (per token) | 600 per min |
| Register limit | 30 per min |
| Webhook limit | 120 per min |
| Body caps | 64 KB – 10 MB by route |

Limits are in memory and per process (see [limitations](#known-limitations)). `X-Forwarded-For` is trusted only with `HEIMDALL_TRUST_PROXY`.

## Secrets at rest

`HEIMDALL_SECRET_KEY` (32 bytes) seals sensitive columns as `enc:v1:<iv>:<ciphertext>:<tag>` (base64 parts) with AES-256-GCM. On startup, legacy plaintext rows are re-sealed. A value that fails to decrypt (wrong key, or tampering) is treated as **unset** and logged; it never falls back to plaintext. Backups are redacted by default. A backup with secrets holds plaintext and is re-sealed under the target hub's key on restore. Key rotation means export, then a fresh hub, then restore.

## Outbound requests (SSRF)

Every request to an admin-configured URL goes through `safeFetch`:

- `http` and `https` only, 10 s timeout, 2 MiB response cap;
- DNS is resolved once and the connection is pinned to that IP (prevents DNS rebinding);
- loopback, link-local (including `169.254.169.254`), RFC 1918, ULA and unspecified addresses are refused (`blocked_host`) unless listed in `HEIMDALL_ALLOW_PRIVATE_HOSTS`;
- at most 3 redirects, each validated again.

URLs are also checked when they are saved, so mistakes show up in the form.

## Supply chain and distribution

- No default credentials are shipped. CI runs `scripts/check-no-default-token.sh`, and Compose and Helm refuse to start or render without a bootstrap token.
- `/install.sh` checks every downloaded file against the hub's `SHA256SUMS` before installing. The collector download is checked against the upstream release checksums. Trust ultimately rests on TLS to the hub, so use `https://` outside a lab.
- Agent images are distroless and run as non-root by default. The Compose sample agent runs as root to read `docker.sock` (documented trade-off).
- Dependency audit status (`npm audit`, `govulncheck`) is tracked in the security review.

## Data handling

- Heimdall tokens are redacted from ingested log lines. **Other secrets in logs are stored as-is.** Choose what you ship.
- Logs, metrics and traces are deleted by retention. Open alarms are kept.
- The hub is the only component with database access. Agents never read data back.

## Operator responsibilities

- Serve the hub over TLS, and set `HEIMDALL_PUBLIC_URL` to the `https://` origin.
- Back up `HEIMDALL_SECRET_KEY` separately from database dumps.
- Disable the bootstrap token once all hosts are enrolled. Prefer short-lived, limited-use enrollment tokens.
- Remember that Docker socket access is root-equivalent. Grant it only where container metrics are worth it (`DOCKER=0` to skip).
- Keep `HEIMDALL_ALLOW_PRIVATE_HOSTS` as narrow as possible.

## Known limitations

| Limitation | Impact | Status |
| --- | --- | --- |
| Rate limits, WebAuthn challenges, alert cooldown and pause are per process | Several replicas weaken limits | Deferred (F9) |
| Email lookup at login is global, not per org | Fine for a single tenant, not for multi-org SaaS | Deferred (F8) |
| Agent payloads are validated ad hoc, not with Zod | Malformed input is rejected less uniformly | Partial |
| No per-form CSRF tokens (origin check only) | Relies on browsers sending `Origin` or `Sec-Fetch-Site` | Accepted |
| Without `HEIMDALL_TRUST_PROXY` the hub cannot see client IPs | Per-IP buckets (login, setup, unauthenticated ingest) are shared by all clients | Run behind a proxy you control and set it |
| Sealed secrets carry no AAD | A database writer could swap two `enc:v1:` values between rows | Deferred (needs `v2` format + re-seal) |
| WebAuthn is registration-only | Security keys cannot be used to sign in yet; enrol TOTP too | Deferred |
