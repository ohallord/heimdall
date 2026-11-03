# Runtime threats

Optional **Falco / Sidekick-compatible** webhook ingest for runtime policy events, plus expanded hub-side log threat rules. Privileged eBPF/Falco is **not** a hard dependency — operators who only stream agent logs still get intrusion-adjacent matches.

## What you need

1. Heimdall hub reachable from Sidekick (or any HTTP client that posts Falco-shaped JSON)
2. An admin session to mint/rotate the runtime token under **Settings → Integrations**
3. (Optional) Falco + Sidekick in the cluster — Heimdall does not ship or require them

## Mint a token

1. Sign in as **admin** → **Settings**
2. Under **Integrations → Runtime webhook**, click **Rotate runtime token**
3. Copy the plaintext token once (prefix `hdr_…`)
4. Note the webhook URL (`/api/v1/integrations/runtime/webhook`)

## Sidekick → Heimdall

Configure Sidekick (or a custom forwarder) to POST JSON to:

`https://<your-hub>/api/v1/integrations/runtime/webhook`

Auth: **Bearer** with the `hdr_…` token, or header `X-Heimdall-Token: <token>`.

Accepted bodies:

- A single Falco event object (`rule`, `priority`, `output`, `output_fields`, …)
- An array of events
- `{ "events": [ … ] }`

## What Heimdall stores

| Field | Behavior |
| --- | --- |
| Source | `runtime` on Security findings |
| Title / external id | Falco `rule` |
| Resource | pod / container / hostname when present |
| Severity | Mapped from Falco `priority` |
| Alarms | **New critical** findings → open alarm when `criticalFindingsToAlarms` is on |
| Raw | Full event (incl. `output_fields`) |

## Log rules (no sensor required)

Hub-side patterns on streamed agent logs also detect webshell/C2 download strings and privilege-escalation indicators (in addition to the SSH, sudo, reverse-shell and crypto-miner rules). See **Logs** and **Alarms** for matches.

## Verify

1. POST a sample Falco event with the runtime token
2. Open **Dashboard → Security** → filter **Runtime**
3. Critical priorities should also appear under **Alarms** when the findings→alarms setting is enabled

## Rotate

Rotating under Settings invalidates the previous token immediately. Update Sidekick before rotating in production.
