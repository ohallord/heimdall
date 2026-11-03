# Runbook: bootstrap and enrollment tokens

All of this lives in **Settings → Agents** (admin; enrollment tokens also for operators).

## Add a new server
1. In Settings → Agents, click **+ Add a server**. The defaults are 1 server and an expiry of 24 h.
2. Copy the command shown (it is displayed once) and run it on the server:
   `curl -fsSL https://<hub>/install.sh | sudo bash` and paste the token at the prompt (`sudo TOKEN=hdt_… bash` also works, but the token is then recorded in sudo's journal entry)
   Use the `OTEL=1` variant to install the collector as well.
3. The server shows up under Fleet → Servers. The token's "Used" count goes up.

Revoking or replacing an enrollment token **never** disconnects servers that are already installed. They authenticate with their own per-agent secret, which also lets them re-register after a restart or reboot once the token has expired or been revoked.

## The hub warns "Insecure bootstrap token"
The hub is accepting the well-known development token, or an env token shorter than 24 characters. Pick one of these:

- **Disable** (recommended if all new servers use "Add a server"). Nothing changes for registered agents.
- **Rotate**: copy the new `hdb_…` token, then run the Helm command shown so the in-cluster agent's env matches:
  ```bash
  helm -n heimdall upgrade heimdall deploy/helm/heimdall --reset-then-reuse-values \
    --set-string hub.env.HEIMDALL_BOOTSTRAP_TOKEN=hdb_…
  ```
  For Compose, set `HEIMDALL_BOOTSTRAP_TOKEN=hdb_…` in `deploy/docker/.env`, then run `docker compose up -d`.

## Modes
| Mode | Accepted bootstrap token |
| --- | --- |
| env (default) | `HEIMDALL_BOOTSTRAP_TOKEN` (or the dev default with `HEIMDALL_DEV=1`, non-production only) |
| rotated | only the `hdb_…` minted on the page; the env value is ignored |
| disabled | none; new servers need an enrollment token |

The mode is stored in `hub_bootstrap` (hub-wide). Only admins of the hub's primary org (the oldest org with an admin) can change it. Replicas pick up a change within 5 s.

## Locked out / lost the rotated token
- An admin can **Rotate** again, or click **Use env value** (returns to env mode).
- With no UI access, run this SQL against the hub DB:
  `UPDATE hub_bootstrap SET mode = 'env', token_hash = NULL, token_hint = NULL WHERE id = 'singleton';`
- Agents that lost their state directory get `409 hostname_in_use`. Re-enroll them with a fresh token after removing the old agent row (existing behaviour; see `deploy.md` → Agent state).
