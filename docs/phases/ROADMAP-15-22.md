# Heimdall Phases 15–22 — One pane of glass

Ordered for **signal quality → operator workflow → product depth → assurance**.  
Spec Kit gates apply to every phase (`research` → `specify` → `design` → `tasks` → `implement` → `converge`).  
**Phase 14 is merged (#36).** Prefer Converge on 14 before Phase 15 Implement; Spec Kit docs for 15–22 may land first.

**Wave B status (2026-10-22):** Phases **16–22** Implemented + Converged (item 6 Assure via [#49](https://cursor.com/codebase/thedanoh/heimdall/pull/49)). **Phase 15** Mount correctness Implement remains deferred (not elevated by Phase 22 security review).

Codebase inventory for Wave B lives in the Project Agent Store (`internal/phase-15-plus-codebase-inventory.md`).

## Why this order

| # | Phase | User ask | Why here |
| --- | --- | --- | --- |
| 15 | [Mount correctness](phase-15-mount-correctness/) | (3) `/var` false missing | Stop alert noise before building an Alarm console on top of it |
| 16 | [Alarm ops](phase-16-alarm-ops/) | (1) dashboard/mute/dismiss · (2) rich Email/Slack | Operability once mounts are trustworthy |
| 17 | [Operator console](phase-17-operator-console/) | (5) site flow/function | Shared IA after Alarms exist as a first-class destination |
| 18 | [Security findings depth](phase-18-security-findings/) | (4) Wiz-like pane | Deepen existing vulns/posture/logs before greenfield sensors |
| 19 | [APM / services](phase-19-apm-services/) | (4) APM metrics | Builds on Phase 14 OTEL ingest |
| 20 | [Runtime threats](phase-20-runtime-threats/) | (4) intrusion / runtime | Optional sensors; constitution keeps eBPF/Falco non-hard-dep |
| 21 | [Network security](phase-21-network-security/) | (4) network security | Deepen UniFi + K8s network posture after core console |
| 22 | [Security review](phase-22-security-review/) | (6) full product security review | Final assurance after features settle |

## Feature groupings (item 4)

```text
Monitor          → hosts, mounts, containers, K8s, history          (9–12, 15)
Alarm & notify   → open alarms, mute, dismiss, rich channels        (16)
Operate          → shared nav, problems home, drill-downs           (17)
Secure (posture) → findings triage, asset links, critical→alarms    (18)
Observe (APM)    → services, RED/latency from OTEL                  (19)
Detect (runtime) → log+optional runtime policy signals              (20)
Network defend   → UniFi depth, K8s NetworkPolicy / exposure        (21)
Assure           → threat model, authz, secrets, deps, pen-test     (22)
```

## Parallel research
Research for Phase N+1 may proceed while Phase N Implements. Only **one Implement** agent on the active phase.
