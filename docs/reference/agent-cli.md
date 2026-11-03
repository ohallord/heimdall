# `heimdall-agent` command reference

```
heimdall-agent <command> [flags]
```

All commands that talk to the hub accept `--hub URL` and `--token TOKEN`, or read `HEIMDALL_HUB_URL` and `HEIMDALL_BOOTSTRAP_TOKEN`. Flags win over environment variables. The full variable list is in [configuration](configuration.md#agent).

## `run`

The long-running mode used by the systemd unit and the container images.

```
heimdall-agent run [--hub URL] [--token TOKEN] [--hostname NAME] [--interval 10s]
                   [--cluster-id ID] [--watch-mounts /,/var] [--log-paths a,b]
                   [--enable-k8s true|false]
```

On start, the agent:

1. Loads its secret from `HEIMDALL_STATE_DIR`, then registers. With a stored secret it re-attaches to its existing identity. Without one, it uses the token and stores the new `hda_` secret it receives.
2. Runs an initial host posture scan, if `HEIMDALL_HOST_POSTURE=1` and Trivy is available.
3. Every `--interval`, collects host metrics, containers (if a socket is found) and Kubernetes (if enabled), sends them to the hub, and ships any new lines from `--log-paths`.
4. On `401` from ingest (for example after the hub was restored or the host was re-enrolled), it registers again, presenting its stored secret.

A state directory that cannot be read is fatal (`state error`). Registering without the stored secret would be refused with `409`.

Exits non-zero on configuration errors or a failed first registration. systemd restarts it.

## `register`

Register once and print the result. Useful to test a token.

```
heimdall-agent register [--hub URL] [--token TOKEN] [--hostname NAME] [--cluster-id ID]
```

## `collect`

Collect one sample and print a one-line summary (CPU, memory, load, mounts, containers and runtime, and K8s status if enabled). Use it to check what the agent can see. It does not contact the hub. However, config validation still requires a token value, so set `--token` or `HEIMDALL_BOOTSTRAP_TOKEN` (any value works).

```
heimdall-agent collect [--watch-mounts /,/boot] [--enable-k8s true] --token x
# cpu=3.2% mem=41.0% load1=0.12 mounts=3 disks=3 containers=7 runtime=docker k8s=[disabled]
```

## `scan-image`

Scan a container image with Trivy and send the findings (source `trivy`).

```
heimdall-agent scan-image --image NAME[:TAG] [--hub URL] [--token TOKEN]
```

## `scan-host`

Scan a root filesystem with `trivy rootfs --scanners vuln,misconfig` and send the findings (source `host_posture`).

```
heimdall-agent scan-host [--root PATH] [--hostname NAME] [--hub URL] [--token TOKEN]
```

`--root` defaults to `HEIMDALL_HOST_ROOT`, otherwise `/host` if that directory exists, otherwise `/`. The timeout is `HEIMDALL_TRIVY_TIMEOUT` (default 10 minutes).

## `watch-logs`

Tail log files and ship them, without collecting metrics.

```
heimdall-agent watch-logs --log-paths /var/log/auth.log[,…] [--hub URL] [--token TOKEN]
```

Each poll reads up to 200 new lines per file. Read positions are kept in memory, so after a restart the agent reads each file from the beginning again.

## `version`

Print the build version: the git short SHA for hub-served builds, `dev` otherwise.
