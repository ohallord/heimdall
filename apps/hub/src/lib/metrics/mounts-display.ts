import type { DiskMetric, MountMetric } from "@/lib/db/types";

/** One row in a host's Filesystems table (Phase 15: discovered vs expected). */
export type FilesystemRow = {
  path: string;
  /** On the agent's expect list (`HEIMDALL_WATCH_MOUNTS`); only these can be missing. */
  expected: boolean;
  present: boolean;
  device?: string;
  fsType?: string;
  totalBytes?: number;
  usedPercent?: number;
};

/**
 * Expected-but-missing mounts first, then every filesystem the agent discovered
 * (agent order), then expected mounts that are present but had no usage sample.
 */
export function filesystemRows(
  mounts: MountMetric[],
  disks: DiskMetric[],
): FilesystemRow[] {
  const expected = new Map(mounts.map((m) => [m.path, m]));
  const rows: FilesystemRow[] = mounts
    .filter((m) => !m.present)
    .map((m) => ({ path: m.path, expected: true, present: false }));
  const seen = new Set(rows.map((r) => r.path));

  for (const d of disks) {
    if (seen.has(d.mountPoint)) continue;
    seen.add(d.mountPoint);
    rows.push({
      path: d.mountPoint,
      expected: expected.has(d.mountPoint),
      present: true,
      device: d.device,
      fsType: d.fsType ?? expected.get(d.mountPoint)?.fsType,
      totalBytes: d.totalBytes,
      usedPercent: d.usedPercent,
    });
  }
  for (const m of mounts) {
    if (!m.present || seen.has(m.path)) continue;
    seen.add(m.path);
    rows.push({
      path: m.path,
      expected: true,
      present: true,
      device: m.device,
      fsType: m.fsType,
      totalBytes: m.totalBytes,
      usedPercent: m.usedPercent,
    });
  }
  return rows;
}

function parseArray<T>(json: string | null | undefined): T[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** Rows straight from an `agent_metric_latest` row's JSON columns. */
export function filesystemRowsFromJson(
  mountsJson: string | null | undefined,
  disksJson: string | null | undefined,
): FilesystemRow[] {
  return filesystemRows(parseArray<MountMetric>(mountsJson), parseArray<DiskMetric>(disksJson));
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
