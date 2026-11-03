# Architecture decision log

Short records of the decisions that shape Heimdall. Each one gives the context, the decision and its consequences.

---

### ADR-001: Hub plus outbound agents
**Context.** Monitored hosts sit behind NAT, on home labs and varied networks. Pull-based scraping needs inbound reachability and service discovery.
**Decision.** Agents push to one hub over HTTP(S). The hub never initiates connections to hosts.
**Consequences.** Works through firewalls with no per-host configuration. The hub must be reachable from every agent. Liveness is inferred from the last push (about 45 s). There is no on-demand scrape from the hub.

### ADR-002: A single Next.js app for UI and API
**Context.** A small team, and a desire for one deployable.
**Decision.** The hub is one Next.js App Router service: React server components for the UI, route handlers for the REST API, and in-process background jobs.
**Consequences.** One container, one port (43123). Background work (retention, alert dispatch) shares the web process. Some state lives in process memory, which limits horizontal scaling (see ADR-009).

### ADR-003: PostgreSQL in production, PGlite in development and tests
**Context.** Developers and CI need a database with zero setup. Production needs durability.
**Decision.** One SQL schema runs on both. The hub uses Postgres when `DATABASE_URL` is set, otherwise in-process PGlite.
**Consequences.** The schema avoids Postgres-only features. JSON is stored as text. Tests run against real SQL quickly.

### ADR-004: The schema is applied on boot with additive DDL
**Context.** Self-hosters upgrade irregularly, and a separate migration step is easy to forget.
**Decision.** `schema.sql` runs on every start, and changes are written as `IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`.
**Consequences.** Upgrades need no manual step, and rollback to an older hub usually works. Destructive changes (renames, type changes) need careful hand-written guards in the same file.

### ADR-005: One Go agent binary with capability detection
**Context.** Separate host, container and Kubernetes agents multiply install paths.
**Decision.** One static binary. Collectors turn on when their prerequisite exists (a socket, `HEIMDALL_ENABLE_K8S`, Trivy on `PATH`).
**Consequences.** Simple installs, and a distroless image is possible. The binary includes client-go, which makes it larger and brings `golang.org/x/net` CVEs (tracked in the security review).

### ADR-006: Dual-band thresholds and suffixed alert identities
**Context.** Single thresholds were either noisy or late. One "disk" alarm hid which mount was full.
**Decision.** CPU, memory and disk get warn (record only) and alarm (notify) bands with Netdata-style defaults. Per-instance metrics carry suffixes (`disk_percent:/var`, `container_exited:web`), and the fingerprint covers the suffix.
**Consequences.** Fewer pages, clearer messages, and recovery per instance. Rules match by prefix.

### ADR-007: Per-agent secrets instead of shared tokens
**Context.** A shared bootstrap token let anyone holding it re-register any hostname and take over its identity (F12).
**Decision.** Registration mints an `hda_` secret per agent. Enrollment tokens (`hdt_`) only create new agents and carry a TTL and max uses. Re-registering an existing hostname requires its secret (`409` otherwise). Revoke and re-enroll are admin actions.
**Consequences.** The agent state directory must persist. Old agents keep working until `HEIMDALL_LEGACY_TOKENS=off`.

### ADR-008: No shipped default credentials
**Context.** A dev bootstrap token in Compose, Helm and the agent was a well-known key to every install (F14).
**Decision.** Compose, Helm and the agent require operator-supplied values. The dev token exists only with `HEIMDALL_DEV=1` outside production. CI enforces this.
**Consequences.** Slightly more setup friction. The hub warns at startup if a weak token is configured.

### ADR-009: In-process rate limits, cooldown and pause
**Context.** The target deployment is a single replica. External state (Redis) adds an operational dependency.
**Decision.** Keep these counters in process memory.
**Consequences.** Simple and fast. Restarts reset them, and several replicas each hold their own copy (notifications may multiply, limits split). Revisit if multi-replica becomes a goal.

### ADR-010: Fire-and-forget notification delivery
**Context.** SMTP and webhook latency must not slow agent ingest.
**Decision.** Ingest queues notifications asynchronously in process, with no persistence or retry.
**Consequences.** Ingest stays fast. A crash or failed send loses that notification (the alarm is still in the console).

### ADR-011: Encrypt stored secrets with an operator-held key
**Context.** Third-party credentials and TOTP seeds sat in plaintext in the database (F6).
**Decision.** AES-256-GCM with `HEIMDALL_SECRET_KEY`, versioned prefix `enc:v1:`, startup migration, fail-closed decrypt. Helm generates and keeps the key.
**Consequences.** Database dumps alone do not leak credentials. Losing the key means re-entering secrets. Rotation is export, fresh hub, restore.

### ADR-012: SSRF guard on every admin-configured URL
**Context.** Admin-entered URLs (IdP, webhooks, SCM APIs) could target cloud metadata or internal services (F13).
**Decision.** All such calls go through `safeFetch`: private and link-local addresses blocked, DNS pinning, redirects re-validated, size and time caps, with an explicit `HEIMDALL_ALLOW_PRIVATE_HOSTS` allowlist.
**Consequences.** LAN services need an allowlist entry, which is the most common setup surprise.

### ADR-013: OTLP/HTTP JSON only, collectors in front
**Context.** Supporting gRPC and protobuf in the hub adds dependencies and code.
**Decision.** The hub accepts OTLP/HTTP with JSON encoding (`415` for protobuf). Apps send to a local OTel Collector, which converts and forwards.
**Consequences.** A collector is always in the path, which also gives batching, retries and host metrics. Direct SDK-to-hub export is not supported.

### ADR-014: The hub serves agent binaries and the installer
**Context.** Requiring a Go toolchain or repo checkout on every host was the biggest install hurdle.
**Decision.** The hub image builds the agent for amd64 and arm64 and serves `/install.sh` and `/downloads/*`, verified by `SHA256SUMS`.
**Consequences.** Hosts are added with one `curl | sudo bash`. Trust rests on TLS to the hub. Agent upgrades mean re-running the installer.

### ADR-015: Problems-first, light-first operator console
**Context.** Generic dashboards bury failures among vanity stats.
**Decision.** The design system in [`DESIGN.md`](../../DESIGN.md): IBM Plex, hairline structure, status dots, a single teal accent, problems ranked first. Servers, Kubernetes and containers are separate sections.
**Consequences.** A consistent, dense UI. New pages follow the same rules.
