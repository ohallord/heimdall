# Wave C — Phases 23+

Starter roadmap after Wave B (15–22). Phase 15 Mount correctness Implement remains deferred and is **not** mixed into Wave C PRs.

| Phase | Focus | Why |
| --- | --- | --- |
| [23 Baremetal + OTEL logs](phase-23-baremetal-otel-logs/) | Unified baremetal install (agent + otelcol); OTLP/HTTP JSON logs → `log_events` | Phase 14 shipped metrics-only OTEL and deferred logs; operators need one script for host metrics + service logs |

## Ordering notes

- Spec Kit docs (R→S→D→T) for Phase 23 may proceed while Phase 15 Implement stays deferred.
- One PR per phase; do not fold Phase 15 mount work into Phase 23.
- Later Wave C phases (traces, Alloy UX, etc.) stay out of constitution until researched.
