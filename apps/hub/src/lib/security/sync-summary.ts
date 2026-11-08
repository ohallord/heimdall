/** Turn a /api/v1/security/scan response into the status line plus each warning's text. */
export function syncSummary(data: unknown): { message: string; warnings: string[] } {
  const d = (data ?? {}) as { written?: unknown; errors?: unknown };
  const written = typeof d.written === "number" ? d.written : 0;
  const warnings = Array.isArray(d.errors)
    ? d.errors.filter((e): e is string => typeof e === "string")
    : [];
  return {
    message:
      `Synced ${written} finding(s)` +
      (warnings.length ? ` · ${warnings.length} warning(s)` : ""),
    warnings,
  };
}
