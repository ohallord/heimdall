import type { ContainerMetric } from "@/lib/db/types";

/** Shorten sha256 digests for the IMAGE column; keep tagged names intact. */
export function truncateImageRef(image: string, head = 8, tail = 0): string {
  const raw = (image || "").trim();
  if (!raw) return "—";
  const m = raw.match(/^(sha256:)([0-9a-f]{16,})$/i);
  if (m) {
    const digest = m[2];
    if (digest.length <= head + Math.max(tail, 0) + 1) return raw;
    if (tail > 0) {
      return `${m[1]}${digest.slice(0, head)}…${digest.slice(-tail)}`;
    }
    return `${m[1]}${digest.slice(0, head)}…`;
  }
  // repo@sha256:…
  const at = raw.match(/^(.*@sha256:)([0-9a-f]{16,})$/i);
  if (at) {
    const digest = at[2];
    if (digest.length <= head + 1) return raw;
    return `${at[1]}${digest.slice(0, head)}…`;
  }
  return raw;
}

export function isRunningState(state: string | undefined): boolean {
  const s = (state || "").toLowerCase();
  return s === "running" || s === "restarting";
}

export function isHeimdallStackContainer(c: Pick<ContainerMetric, "name" | "image">): boolean {
  const name = (c.name || "").toLowerCase();
  const image = (c.image || "").toLowerCase();
  return (
    name.startsWith("heimdall-") ||
    name.includes("heimdall_") ||
    image.includes("heimdall/") ||
    image.includes("heimdall-")
  );
}

export type ContainerStateTone = "running" | "exited" | "created" | "other";

export function containerStateTone(state: string | undefined): ContainerStateTone {
  const s = (state || "").toLowerCase();
  if (s === "running") return "running";
  if (s === "exited" || s === "dead") return "exited";
  if (s === "created" || s === "paused") return "created";
  return "other";
}

export function filterContainers<T extends Pick<ContainerMetric, "state">>(
  containers: T[],
  opts: { showStopped: boolean },
): T[] {
  if (opts.showStopped) return containers;
  return containers.filter((c) => isRunningState(c.state));
}
