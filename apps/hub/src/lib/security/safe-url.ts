/** Only http(s) links from agents / SCM APIs are rendered; anything else (javascript:, data:) is dropped. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
