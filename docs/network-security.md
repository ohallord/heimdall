# Network security depth (Phase 21)

Heimdall deepens network posture without becoming an NMS or full CSPM:

1. **UniFi** — Alarm Manager webhooks on **Network**, grouped by alarm category/type and device (see [unifi.md](unifi.md)).
2. **Kubernetes** — Agents report exposed Services (NodePort / LoadBalancer / ExternalIP) and a NetworkPolicy coverage summary for the active cluster.

## UniFi grouping

New events store `device` and `category` on the alert payload. The Network page sections alerts by category (fallback: alarm name), then device. Older events without those fields recover Network `parameters.UNIFIhost` / `UNIFIcategory` from raw JSON when present.

## K8s exposure

Requires:

- Agent with K8s collection enabled (`HEIMDALL_ENABLE_K8S` / helm agent)
- Helm chart RBAC that can **list** `services`, `namespaces`, and `networking.k8s.io/networkpolicies` (Phase 21 chart update)

Upgrade the Heimdall helm release (or patch the agent ClusterRole) so collection is not empty. Missing RBAC soft-fails: cluster health still reports; exposure lists stay empty.

### What appears on Network

| Signal | Meaning |
| --- | --- |
| Exposed Services | NodePort, LoadBalancer, or ExternalIP Services (capped) |
| NetworkPolicy coverage | Namespaces with ≥1 NetworkPolicy vs without; short list of uncovered namespaces |

This is a **summary** for operators — not vulnerability findings. Security findings remain under **Security** (Trivy/OSV/runtime/etc.).

## Verify

1. Post a UniFi WAN test webhook → Network shows it under category + device.
2. Run an agent against a cluster with a NodePort Service → Network **K8s exposure** lists it after the next metrics ingest.
