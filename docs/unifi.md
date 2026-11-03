# UniFi alerts

Send UniFi **Alarm Manager** events into Heimdall via a shared-secret webhook. Events appear on **Network** and **Alert history**. Critical severities also fan out to configured notification channels.

Heimdall does **not** replace the UniFi Network application. Local API polling is deferred.

## What you need

1. Heimdall hub reachable from your UniFi console (HTTPS recommended)
2. Network **9.3+** (Alarm Manager) — Protect webhooks use the same Heimdall endpoint
3. An admin session to mint/rotate the UniFi token under **Settings → Integrations**

## Mint a token

1. Sign in as **admin** → **Notifications** (Settings)
2. Under **Integrations → UniFi webhook**, click **Rotate UniFi token**
3. Copy the plaintext token once (prefix `hdu_…`)
4. Note the webhook URL shown (path `/api/v1/integrations/unifi/webhook`)

## Alarm Manager → Heimdall

1. Open UniFi Network → **Alarm Manager** → create or edit an alarm
2. Add action **Webhook** → **Custom Webhook**
3. URL: `https://<your-hub>/api/v1/integrations/unifi/webhook`
4. Method: **POST**
5. Auth: **Bearer** with the `hdu_…` token  
   — or custom header `X-Heimdall-Token: <token>`
6. Save and use **Test** if available

Recommended triggers: internet disconnected, high latency, packet loss, device offline.

## What Heimdall stores

| Field | Behavior |
| --- | --- |
| Message | Network `message` / `name`, or Protect alarm name + triggers |
| Severity | Numeric/string severity, or heuristics (offline/outage → critical) |
| Device | Network `parameters.UNIFIhost`, or first Protect `triggers[].device` |
| Category | Network `UNIFIcategory` (+ optional `UNIFIsubCategory`) |
| Payload | `source: "unifi"` plus name/device/category and raw JSON |
| Notify | **critical** → Slack/Discord/SMTP/SMS (pause/quiet-hours apply) |

On **Dashboard → Network**, UniFi alerts are grouped by category (or alarm name), then device. See also [network-security.md](network-security.md) for K8s exposure on the same page.

## Verify

- Fire a test alarm → **Dashboard → Network** should list the event under its type and device
- Critical events also show under **Alert history** and hit channels if configured

## Rotate

Rotating under Settings invalidates the previous token immediately. Update Alarm Manager (or the custom header) before rotating in production.
