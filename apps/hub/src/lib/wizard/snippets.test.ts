import { describe, expect, it } from "vitest";
import { buildInstallSnippets, isLocalHubUrl } from "./snippets";

describe("install snippets", () => {
  it("detects local hub URLs", () => {
    expect(isLocalHubUrl("http://127.0.0.1:43123")).toBe(true);
    expect(isLocalHubUrl("http://localhost:43123")).toBe(true);
    expect(isLocalHubUrl("https://heimdall.example.com")).toBe(false);
  });

  it("embeds hub URL and token; local hubs avoid unpublished registry pulls", () => {
    const snippets = buildInstallSnippets({
      hubUrl: "http://127.0.0.1:43123/",
      token: "hdt_testtoken",
      hostname: "edge-01",
    });
    expect(snippets.systemd).toContain("HEIMDALL_HUB_URL=http://127.0.0.1:43123");
    expect(snippets.systemd).toContain("hdt_testtoken");
    expect(snippets.docker).not.toContain("heimdall/agent:0.0.1");
    expect(snippets.docker).toContain("heimdall-agent:latest");
    expect(snippets.docker).toContain("docker compose run");
    expect(snippets.docker).toContain("--user root");
    expect(snippets.docker).toContain("/var/run/docker.sock");
    expect(snippets.docker).toContain("go run ./cmd/agent run");
    expect(snippets.docker).toContain("compose-agent-01");
    expect(snippets.kubernetes).toContain("kind: Deployment");
    expect(snippets.kubernetes).toContain("kind: ClusterRole");
    expect(snippets.kubernetes).toContain("HEIMDALL_ENABLE_K8S");
    expect(snippets.kubernetes).toContain("edge-01");
    expect(snippets.kubernetes).toContain("imagePullPolicy: IfNotPresent");
    expect(snippets.systemd).toContain("heimdall-agent run");
    expect(snippets.systemd).toContain("HEIMDALL_CLUSTER_ID=default");
    expect(snippets.systemd).toContain("install-agent.sh");
    expect(snippets.systemd).toContain("install-baremetal.sh");
    expect(snippets.systemd).toContain("deploy/systemd/heimdall-agent.service");
    expect(snippets.kubernetes).toContain("events");
    expect(snippets.kubernetes).toContain("pods/log");
  });

  it("leads the systemd tab with the one-command hub install", () => {
    for (const hubUrl of ["http://127.0.0.1:43123/", "https://heimdall.example.com"]) {
      const s = buildInstallSnippets({ hubUrl, token: "hdt_x" }).systemd;
      const hub = hubUrl.replace(/\/$/, "");
      expect(s.split("\n")[1]).toContain(`curl -fsSL ${hub}/install.sh | sudo bash`);
      expect(s).toContain(`curl -fsSL ${hub}/install.sh | sudo TOKEN=hdt_x bash`);
      expect(s).toContain(`curl -fsSL ${hub}/install.sh | sudo OTEL=1 bash`);
      expect(s).not.toContain("TOKEN=hdt_x OTEL=1");
      expect(s).toContain("--uninstall");
    }
  });

  it("still emits docker run for non-local hubs with local image tag", () => {
    const snippets = buildInstallSnippets({
      hubUrl: "https://heimdall.example.com",
      token: "hdt_prod",
      hostname: "edge-01",
    });
    expect(snippets.docker).toContain("heimdall-agent:latest");
    expect(snippets.docker).not.toContain("heimdall/agent:0.0.1");
    expect(snippets.docker).not.toContain("docker compose run");
  });
});
