# End-to-end / integration

A process-level handshake smoke test registers an agent against a freshly built hub:

```bash
# from repo root (hub must be buildable; script builds if needed)
./scripts/handshake-smoke.sh
```

CI runs it on every push. A Compose-based end-to-end suite (Postgres + hub + agent containers) is not written yet; contributions welcome.
