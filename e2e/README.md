# End-to-end / integration

Phase 0 ships a process-level handshake smoke test:

```bash
# from repo root (hub must be buildable; script builds if needed)
./scripts/handshake-smoke.sh
```

Compose-based e2e (Postgres + hub + agent containers) is deferred until Docker is available in the target CI/runtime and Phase 1 adds durable persistence.
