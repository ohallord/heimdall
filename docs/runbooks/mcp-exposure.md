# Runbook: expose the read-only MCP endpoint

The hub serves a read-only MCP endpoint at `/mcp` (streamable HTTP, one JSON-RPC call per POST). It reports fleet state for `HEIMDALL_ORG_ID` when that org exists, otherwise the org that has an admin, otherwise the oldest org. It cannot mute, dismiss, enroll, or change anything. Dashboard session cookies do not authorize it. `heimdall_alerts` returns open counts by rule and accepts `rule`, `host`, and `offset` so a flood of one rule does not hide the rest.

The LAN keeps using the hub URL for the dashboard, agents, and `/api/v1`. This runbook publishes `/mcp` plus the OAuth routes Grok uses (`/oauth/` and `/.well-known/oauth-`). Tool results leave the homelab and are sent to the model connected to that endpoint. Grok does not send the static bearer. It opens `/oauth/authorize` in the browser. Sign in with the hub email, password, and authenticator code when MFA is enrolled.

The owner runs `scripts/expose-mcp.py`. CI must not.

## Token

Generate a token and set it on the hub. Do not commit it.

```bash
openssl rand -hex 32
```

- Helm: `hub.env.HEIMDALL_MCP_TOKEN` (stored in the chart Secret as `mcp-token`, empty by default so an upgrade does not invent one) or `hub.mcp.existingSecret`. Also set `hub.env.HEIMDALL_MCP_ALLOWED_HOSTS`. Helm `--set-string` splits on commas, so put the allowlist in a values file or escape the commas (`hub.lan\,mcp.example.com`).
- Compose / `.env`: `HEIMDALL_MCP_TOKEN` and `HEIMDALL_MCP_ALLOWED_HOSTS`.

If `HEIMDALL_MCP_TOKEN` is unset, only `localhost`, `127.0.0.1`, and `::1` can call `/mcp`. Any other Host is `401` with `WWW-Authenticate: Bearer realm="heimdall"`.

When the token is set, a wrong or missing bearer is the same `401`. `HEIMDALL_MCP_ALLOWED_HOSTS` (comma-separated) is the Host allowlist and should list the LAN host the hub sees and the public host. Localhost is always included. If the allowlist is empty while the token is set, any Host is accepted and the bearer is the guard.

## Dry run

```bash
python3 scripts/expose-mcp.py
```

That prints the owner steps and the tunnel ingress. It does not call Cloudflare.

The public name must be a hostname in a Cloudflare zone you control. The script's placeholder is `heimdall-mcp.example`, not a real domain. Override it:

```bash
HEIMDALL_MCP_HOSTNAME=mcp.example.com python3 scripts/expose-mcp.py
```

`HEIMDALL_MCP_ORIGIN` is where cloudflared reaches the hub (default `http://127.0.0.1:43123`).

## Ingress

The tunnel named `heimdall-mcp` allows `^/mcp`, `^/oauth/`, and `^/.well-known/oauth-`. Every other path, including `/api/v1`, `/dashboard`, and `/health`, is `http_status:404`. After this list changes, run `--apply` again so the live tunnel picks it up.

## Apply

`--apply` was not run as part of shipping this. When you choose to run it, export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (do not put them in the repo) and run:

```bash
python3 scripts/expose-mcp.py --apply
```

It creates or reuses the tunnel, writes the ingress, points a proxied CNAME at `<tunnel-id>.cfargotunnel.com`, and starts pinned `cloudflare/cloudflared:2026.10.7` (not `latest`). The tunnel token is passed to the container by the environment and is not printed.

There is no Cloudflare Access policy and no Worker in this path.
