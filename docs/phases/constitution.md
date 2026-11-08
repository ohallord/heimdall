# Constitution — Heimdall Phases 9–23

Guiding principles for every research / spec / plan / implement gate. Update only with explicit product agreement.

## Product

1. **Hub + outbound agents** — agents dial out; hub never requires inbound to every host.
2. **Simple setup** — wizard + three install paths (Helm, Compose, standalone) must stay understandable.
3. **Problems-first UI** — industrial operator console (`DESIGN.md`); status dots over pill spam; light-first.
4. **Servers ≠ Kubernetes ≠ Containers** — separate IA; bare metal does not show empty container chrome.
5. **Configurable with good defaults** — thresholds and retention ship with researched defaults; admins can change.
6. **One pane of glass** — prefer deepening Heimdall surfaces over forcing operators into Grafana/Wiz/PagerDuty for routine work; deep PromQL and full CSPM stay non-goals until constitution says otherwise.
7. **Trustworthy signals** — fix false positives (e.g. mount watch) before expanding alarm UX on top of noise.

## Engineering

1. **Spec before code** — no Implement until Proposal + Design + Tasks exist for that phase.
2. **Resume-safe** — every gate updates checkboxes in `tasks.md` and `STATUS.md`; **check in (commit) after each gate**; discussion-log at Converge.
3. **One PR per phase** — after all gates’ work is on the branch: open/update PR, run tests, **merge if green**, then Converge.
4. **Tests with features** — collectors, ingest, alert bands, parsers, and UI contracts get fixtures/tests in the same phase.
5. **Small focused phases** — conventional commits; reference phase in PR body.
6. **No secret on argv** — tokens via env / wizard / settings only.

## Research bar

Each phase Research MUST cite at least one external product pattern (e.g. Netdata, Grafana, UniFi, Trivy, OTEL, PagerDuty, Wiz docs) and one codebase gap (file paths) before Propose.

## Explicit non-goals (until a later constitution update)

- Replacing full Grafana/Prometheus for deep PromQL.
- Full UniFi NMS (controller replacement).
- Privileged eBPF/Falco as a **hard** dependency (optional adapters OK in later phases).
- Public OSS announcement before quality bar.
- Full cloud CSPM / multi-cloud attack-path graph (may appear as later researched phases, not Phase 15–17).

## Phase bands

| Band | Phases | Focus |
| --- | --- | --- |
| 9–14 | Complete / closing | Host depth, posture, UniFi, OTEL foundation |
| 15–17 | Operator trust & workflow | Mounts, alarms, console IA |
| 18–21 | One-pane depth | Findings, APM, runtime, network |
| 22 | Assurance | Full product security review |
| 23+ | Wave C | Baremetal observability depth (OTLP logs, unified install); Phase 15 Implement remains a separate deferred track |
