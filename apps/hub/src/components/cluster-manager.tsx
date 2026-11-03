"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  countK8sProblems,
  isK8sCollectionEnabled,
  k8sApiLabel,
} from "@/lib/metrics/k8s-status";
import type { K8sClusterMetric } from "@/lib/db/types";

export type ClusterView = {
  clusterId: string;
  name: string;
  isActive: boolean;
  kubernetes: Pick<
    K8sClusterMetric,
    | "enabled"
    | "nodesReady"
    | "nodesTotal"
    | "podsPending"
    | "podsCrashLoop"
    | "deploymentsUnhealthy"
    | "apiServerReachable"
    | "apiServerError"
    | "clusterId"
  > | null;
};

export function ClusterManager({
  initialClusters,
  activeClusterId,
  canWrite,
}: {
  initialClusters: ClusterView[];
  activeClusterId: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [clusters, setClusters] = useState(initialClusters);
  const [active, setActive] = useState(activeClusterId);
  const [clusterId, setClusterId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function activate(id: string) {
    if (!canWrite) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/clusters/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clusterId: id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "activate failed");
      setActive(data.activeClusterId);
      setClusters((prev) =>
        prev.map((c) => ({
          ...c,
          isActive: c.clusterId === data.activeClusterId,
        })),
      );
      setMessage(`Active cluster: ${data.activeClusterId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "activate failed");
    } finally {
      setBusy(false);
    }
  }

  async function addCluster(e: React.FormEvent) {
    e.preventDefault();
    if (!canWrite) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/clusters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clusterId,
          name: name || clusterId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "create cluster failed",
        );
      }
      setClusterId("");
      setName("");
      setMessage(`Registered ${data.cluster.clusterId}`);
      router.refresh();
      const list = await fetch("/api/v1/clusters");
      const listed = await list.json();
      if (list.ok) {
        setClusters(listed.clusters);
        setActive(listed.activeClusterId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Clusters
          </h2>
          <p className="mt-1 text-xs text-muted">
            Active: <span className="font-mono text-signal">{active}</span>
          </p>
        </div>
        {clusters.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">
            No clusters yet. Agents register with{" "}
            <code className="font-mono text-xs">cluster_id</code> (default{" "}
            <code className="font-mono text-xs">default</code>).
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2">ID</th>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">K8s</th>
                <th className="px-4 py-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {clusters.map((c) => {
                const k = c.kubernetes;
                const enabled = isK8sCollectionEnabled(k);
                const problems = countK8sProblems(k);
                return (
                  <tr key={c.clusterId} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 font-mono text-xs">{c.clusterId}</td>
                    <td className="px-4 py-3">{c.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">
                      {!k
                        ? "—"
                        : !enabled
                          ? k8sApiLabel(k)
                          : `${k.nodesReady}/${k.nodesTotal} nodes · ${problems} problems`}
                    </td>
                    <td className="px-4 py-3">
                      {c.isActive ? (
                        <span className="font-mono text-xs text-ok">active</span>
                      ) : canWrite ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => activate(c.clusterId)}
                          className="border border-border px-2 py-1 text-xs text-muted hover:border-signal hover:text-signal disabled:opacity-60"
                        >
                          Activate
                        </button>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {canWrite ? (
        <form
          onSubmit={addCluster}
          className="space-y-3 border border-border bg-surface p-4"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Register cluster
          </h2>
          <label className="block text-sm">
            <span className="mb-1 block font-mono text-xs uppercase text-muted">
              Cluster ID
            </span>
            <input
              className="w-full border border-border px-3 py-2 font-mono text-sm"
              value={clusterId}
              onChange={(e) => setClusterId(e.target.value)}
              placeholder="prod-us-east"
              required
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-mono text-xs uppercase text-muted">
              Display name
            </span>
            <input
              className="w-full border border-border px-3 py-2 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production US East"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            Add cluster
          </button>
        </form>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {message ? <p className="text-sm text-ok">{message}</p> : null}
    </div>
  );
}
