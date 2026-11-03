export type InstallSnippets = {
  systemd: string;
  docker: string;
  kubernetes: string;
};

/** True for hubs that are not expected to pull from a public registry. */
export function isLocalHubUrl(hubUrl: string): boolean {
  try {
    const u = new URL(hubUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "host.docker.internal" ||
      host === "hub" ||
      host.endsWith(".local")
    ) {
      return true;
    }
    // RFC1918 — typical home/lab Compose
    if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
    if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(host)) return true;
    return u.protocol === "http:";
  } catch {
    return false;
  }
}

export function buildInstallSnippets(input: {
  hubUrl: string;
  token: string;
  hostname?: string;
}): InstallSnippets {
  const hostname = input.hostname ?? "$(hostname)";
  const hub = input.hubUrl.replace(/\/$/, "");
  const token = input.token;
  const local = isLocalHubUrl(hub);
  const oneCommand = `# One command (Linux + systemd, x86_64/aarch64), agent served by this hub:
#   curl -fsSL ${hub}/install.sh | sudo bash                 # prompts for the token below
# Non-interactive (the token ends up in sudo's system log):
#   curl -fsSL ${hub}/install.sh | sudo TOKEN=${token} bash
# Agent + OTel collector (metrics, logs, traces; prompts for both tokens):
#   curl -fsSL ${hub}/install.sh | sudo OTEL=1 bash
# Remove: curl -fsSL ${hub}/install.sh | sudo bash -s -- --uninstall
#
# Manual alternatives below.
`;

  const systemd = oneCommand + (local
    ? `# Local / Compose hub — standalone agent via install script + unit.
# From repo root:
#   cd apps/agent && go build -o bin/heimdall-agent ./cmd/agent
#   HUB_URL=${hub} TOKEN=${token} ./scripts/install-agent.sh
# Agent + OTEL metrics/logs (needs OTEL_TOKEN=hdo_… + otelcol-contrib):
#   HUB_URL=${hub} TOKEN=${token} OTEL_TOKEN=hdo_… ./scripts/install-baremetal.sh
# Unit: deploy/systemd/heimdall-agent.service → /etc/systemd/system/
# Or paste a unit with EnvironmentFile=/etc/heimdall/agent.env

[Unit]
Description=Heimdall agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/heimdall
Environment=HEIMDALL_HUB_URL=${hub}
Environment=HEIMDALL_BOOTSTRAP_TOKEN=${token}
Environment=HEIMDALL_HOSTNAME=${hostname}
Environment=HEIMDALL_INTERVAL=10s
Environment=HEIMDALL_CLUSTER_ID=default
Environment=HEIMDALL_ENABLE_K8S=false
ExecStart=/opt/heimdall/bin/heimdall-agent run
Restart=always

[Install]
WantedBy=multi-user.target
`
    : `# Standalone: HUB_URL=${hub} TOKEN=${token} ./scripts/install-agent.sh
# Agent + OTEL logs: HUB_URL=${hub} TOKEN=${token} OTEL_TOKEN=hdo_… ./scripts/install-baremetal.sh
# Checked-in unit: deploy/systemd/heimdall-agent.service

[Unit]
Description=Heimdall agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HEIMDALL_HUB_URL=${hub}
Environment=HEIMDALL_BOOTSTRAP_TOKEN=${token}
Environment=HEIMDALL_HOSTNAME=${hostname}
Environment=HEIMDALL_INTERVAL=10s
Environment=HEIMDALL_CLUSTER_ID=default
Environment=HEIMDALL_ENABLE_K8S=false
ExecStart=/usr/local/bin/heimdall-agent run
Restart=always

[Install]
WantedBy=multi-user.target
`);

  const docker = local
    ? `# Local Compose — project name "heimdall" builds image heimdall-agent:latest.
# The stack already runs sample agent compose-agent-01; skip this if one agent is enough.
# Host/register metrics work without Docker; container scrape needs the socket + root/docker GID.
#
# Extra agent on the Compose network (from deploy/docker):
cd deploy/docker
export DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
docker compose run --rm --user root \\
  -e HEIMDALL_BOOTSTRAP_TOKEN=${token} \\
  -e HEIMDALL_HOSTNAME=${hostname} \\
  -e HEIMDALL_CLUSTER_ID=default \\
  -e HEIMDALL_ENABLE_K8S=false \\
  agent
#
# Or reuse the built image against the published hub port:
docker run --rm --user root \\
  --add-host=host.docker.internal:host-gateway \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -e HEIMDALL_HUB_URL=${hub} \\
  -e HEIMDALL_BOOTSTRAP_TOKEN=${token} \\
  -e HEIMDALL_HOSTNAME=${hostname} \\
  -e HEIMDALL_INTERVAL=10s \\
  -e HEIMDALL_CLUSTER_ID=default \\
  -e HEIMDALL_ENABLE_K8S=false \\
  -e DOCKER_HOST_SOCKET=/var/run/docker.sock \\
  heimdall-agent:latest run
#
# Or without Docker (repo checkout; add user to docker group for container scrape):
cd apps/agent
go run ./cmd/agent run \\
  --hub ${hub} --token ${token} --hostname ${hostname}
`
    : `docker run --rm --user root \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -e DOCKER_HOST_SOCKET=/var/run/docker.sock \\
  -e HEIMDALL_HUB_URL=${hub} \\
  -e HEIMDALL_BOOTSTRAP_TOKEN=${token} \\
  -e HEIMDALL_HOSTNAME=${hostname} \\
  -e HEIMDALL_INTERVAL=10s \\
  -e HEIMDALL_CLUSTER_ID=default \\
  -e HEIMDALL_ENABLE_K8S=false \\
  heimdall-agent:latest run
`;

  const k8sImage = local ? "heimdall-agent:latest" : "heimdall-agent:latest";
  const k8sNote = local
    ? `# Local hub: load heimdall-agent:latest into the cluster (kind load / minikube image load)
# after: cd deploy/docker && docker compose build agent
`
    : "";

  const kubernetes = `${k8sNote}apiVersion: v1
kind: ServiceAccount
metadata:
  name: heimdall-agent
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: heimdall-agent
rules:
  - apiGroups: [""]
    resources: ["nodes", "pods", "events"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: heimdall-agent
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: heimdall-agent
subjects:
  - kind: ServiceAccount
    name: heimdall-agent
    namespace: default
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: heimdall-agent
spec:
  replicas: 1
  selector:
    matchLabels:
      app: heimdall-agent
  template:
    metadata:
      labels:
        app: heimdall-agent
    spec:
      serviceAccountName: heimdall-agent
      containers:
        - name: agent
          image: ${k8sImage}
          imagePullPolicy: IfNotPresent
          args: ["run", "--interval", "10s"]
          env:
            - name: HEIMDALL_HUB_URL
              value: "${hub}"
            - name: HEIMDALL_BOOTSTRAP_TOKEN
              value: "${token}"
            - name: HEIMDALL_HOSTNAME
              value: "${hostname}"
            - name: HEIMDALL_CLUSTER_ID
              value: "default"
            - name: HEIMDALL_ENABLE_K8S
              value: "true"
`;

  return { systemd, docker, kubernetes };
}
