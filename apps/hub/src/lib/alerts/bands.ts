export type StatusBand = "green" | "yellow" | "red";

/**
 * Utilization band helper (higher value is worse).
 * Boundaries: value >= alarm → red; value >= warn → yellow; else green.
 */
export function bandFor(
  value: number,
  warn: number,
  alarm: number,
): StatusBand {
  if (!Number.isFinite(value) || !Number.isFinite(warn) || !Number.isFinite(alarm)) {
    return "green";
  }
  if (value >= alarm) return "red";
  if (value >= warn) return "yellow";
  return "green";
}

export function bandDotClass(band: StatusBand): string {
  switch (band) {
    case "red":
      return "bg-danger";
    case "yellow":
      return "bg-warn";
    default:
      return "bg-ok";
  }
}

export function bandTextClass(band: StatusBand): string {
  switch (band) {
    case "red":
      return "text-danger";
    case "yellow":
      return "text-warn";
    default:
      return "text-ok";
  }
}

/** Netdata-aligned defaults for host utilization metrics. */
export const HOST_BAND_DEFAULTS: Record<
  string,
  { warn: number; alarm: number }
> = {
  cpu_percent: { warn: 85, alarm: 95 },
  mem_percent: { warn: 90, alarm: 98 },
  disk_percent: { warn: 90, alarm: 98 },
};

export function hostBandDefaultsForMetric(
  metric: string,
): { warn: number; alarm: number } | null {
  if (metric === "disk_percent" || metric.startsWith("disk_percent:")) {
    return HOST_BAND_DEFAULTS.disk_percent;
  }
  return HOST_BAND_DEFAULTS[metric] ?? null;
}
