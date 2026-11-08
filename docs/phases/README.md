# Heimdall Phases 9–23 — Spec-driven tracker

Resume-safe workboard for post–Phase-8 product work. Follows **Spec Kit** gates (research → specify → plan → tasks → implement → converge) with **OpenSpec**-style artifacts per phase (`proposal`, `design`, `specs`, `tasks`).

**Source of truth for checkboxes:** [`STATUS.md`](STATUS.md)  
**Principles:** [`constitution.md`](constitution.md)  
**Phases 15–22 roadmap:** [`ROADMAP-15-22.md`](ROADMAP-15-22.md)  
**Wave C (23+):** [`ROADMAP-23.md`](ROADMAP-23.md)  
**High-level roadmap (9–14):** complete (see STATUS); Wave B detail in [`ROADMAP-15-22.md`](ROADMAP-15-22.md).

## How to pause / resume

1. Open [`STATUS.md`](STATUS.md) — find the first unchecked gate.
2. Open that phase folder’s `tasks.md` — continue from the first unchecked `- [ ]`.
3. When a gate finishes: mark it `[x]` in **both** `tasks.md` and `STATUS.md`, then **check in** (see below).
4. Do not start **Implement** for Phase N+1 until Phase N **Converge** is `[x]`.
5. Append a short outcome to [`../discussion-log.md`](../discussion-log.md) at Converge.

## Check-in + merge policy (required)

**After every gate:** commit progress before moving on.

| Gate | Check-in |
| --- | --- |
| Research / Specify / Design / Tasks | Update Agent Store phase docs + `STATUS.md`. If the repo carries mirrored `docs/phases/` (or other phase artifacts), `git commit` on the phase branch. Always record the gate as done in STATUS before the next gate. |
| Implement | `git commit` on the phase branch after each coherent implement chunk (or after the full implement section for small phases). |
| End of all gates | Open/update **one PR** for the phase → run tests (local + CI) → **merge if green** → Converge (discussion-log + STATUS). |

```text
Research ──commit──► Specify ──commit──► Design ──commit──► Tasks ──commit──►
Implement ──commit(s)──► PR + tests ──► merge if good ──► Converge
```

- One PR per phase (draft until Implement is done; mark ready when tests look good).
- Merge only when tests pass (or known-unrelated flakes documented).
- Do not start the next phase’s Implement until this phase is merged and Converge is `[x]`.

## Workflow per phase (required order)

```text
Research → Proposal (specify) → Design (plan) → Tasks → Implement → PR/tests/merge → Converge
```

| Gate | Artifact | Done when |
| --- | --- | --- |
| Research | `research.md` | Competitive notes + codebase gaps + locked decisions recorded + checked in |
| Specify | `proposal.md` + `specs/*/spec.md` | Requirements + scenarios (WHEN/THEN) reviewed + checked in |
| Plan | `design.md` | Files, APIs, schema, risks locked + checked in |
| Tasks | `tasks.md` | Dependency-ordered checkboxes; `[P]` = parallel-safe + checked in |
| Implement | code on phase branch | Each implement checkbox `[x]`; commits on branch |
| PR / test / merge | Origin PR | Tests green; PR merged to `main` |
| Converge | STATUS + discussion-log | Spec satisfied; merge confirmed; log entry |

## Multi-agent rules

| Allowed in parallel | Not allowed |
| --- | --- |
| Research for multiple *future* phases after constitution is set | Two agents Implementing the same phase |
| Spec/Design for Phase N+1 only after Phase N Research is done (prefer after N Converge for IA-heavy work) | Skipping Research → jump to Implement |
| Independent `[P]` tasks inside one phase’s Implement | Editing another agent’s in-progress `tasks.md` without syncing STATUS |

Suggested fan-out: one **research agent** (read-only) + one **implement agent** on the active phase; optional second research agent on the next phase’s `research.md` only.

## Phase map (user items → phases)

### Wave A (9–14)

| User # | Ask | Phase |
| --- | --- | --- |
| 1–2 | MFA copy + wizard hints | [09](phase-09-ui-polish/) |
| 3 | Server host monitors + G/Y/R | [10](phase-10-server-hosts/) |
| 4 | History / brush zoom / retention | [11](phase-11-metric-history/) |
| 5–7 | Pod detail + install + agent roles | [12](phase-12-k8s-install-agents/) |
| 8 | Host posture | [13](phase-13-host-posture/) |
| 9–10 | UniFi + OTEL | [14](phase-14-unifi-otel/) |

### Wave B (15–22) — Oct 2026 asks

| User ask | Phase | Why this order |
| --- | --- | --- |
| (3) `/var` mount false missing | [15 Mount correctness](phase-15-mount-correctness/) | Trust signals before Alarm UX |
| (1) Alarm dashboard + mute + dismiss · (2) rich Email/Slack | [16 Alarm ops](phase-16-alarm-ops/) | Operability |
| (5) Site flow / function | [17 Operator console](phase-17-operator-console/) | Shared IA after Alarms exist |
| (4) Wiz-like findings depth | [18 Security findings](phase-18-security-findings/) | Deepen existing security |
| (4) APM metrics | [19 APM / services](phase-19-apm-services/) | Build on OTEL |
| (4) Intrusion / runtime | [20 Runtime threats](phase-20-runtime-threats/) | Optional sensors |
| (4) Network security depth | [21 Network security](phase-21-network-security/) | After console + findings |
| (6) Full product security review | [22 Security review](phase-22-security-review/) | **Final** assurance |

### Wave C (23+)

| User ask | Phase | Why |
| --- | --- | --- |
| Baremetal agent + OTEL logs | [23 Baremetal + OTEL logs](phase-23-baremetal-otel-logs/) | Unified install; OTLP logs deferred from Phase 14 |

## Folder layout (OpenSpec-shaped)

```text
docs/phases/
  constitution.md
  STATUS.md
  ROADMAP-15-22.md
  ROADMAP-23.md
  phase-NN-<slug>/
    README.md
    research.md
    proposal.md
    design.md
    specs/
    tasks.md
```
