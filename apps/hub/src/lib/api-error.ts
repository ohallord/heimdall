/** Human-readable message for a failed API JSON body. Spells out `blocked_host` (SSRF guard) with its hint. */
export function apiErrorMessage(data: unknown, fallback: string): string {
  const d = (data ?? {}) as { error?: unknown; detail?: unknown; hint?: unknown };
  if (d.error === "blocked_host") {
    const parts = [
      typeof d.detail === "string" ? d.detail : "blocked_host: this URL points at a private or blocked address",
      typeof d.hint === "string" ? d.hint : "Set HEIMDALL_ALLOW_PRIVATE_HOSTS on the hub to allow it.",
    ];
    return parts.join(" ");
  }
  if (typeof d.error === "string") return d.error;
  if (d.error !== undefined) return JSON.stringify(d.error);
  return fallback;
}
