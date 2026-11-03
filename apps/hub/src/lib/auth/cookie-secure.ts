export type CookieSecureEnv = {
  NODE_ENV?: string;
  HEIMDALL_PUBLIC_URL?: string;
  HEIMDALL_COOKIE_SECURE?: string;
};

/**
 * Whether the iron-session cookie should set the Secure flag.
 *
 * Compose / local hubs serve HTTP (`HEIMDALL_PUBLIC_URL=http://…`) while the
 * Docker image runs `NODE_ENV=production`. Browsers reject Secure cookies on
 * HTTP, which drops the wizard session after org-admin and makes the next
 * step (`POST /api/v1/setup/channels`) return plain `unauthorized`.
 *
 * `env` is injectable for unit tests (avoids assigning read-only `NODE_ENV`).
 */
export function cookieSecure(env: CookieSecureEnv = process.env): boolean {
  const override = env.HEIMDALL_COOKIE_SECURE?.trim().toLowerCase();
  if (override === "true" || override === "1") return true;
  if (override === "false" || override === "0") return false;

  const publicUrl = env.HEIMDALL_PUBLIC_URL?.trim() ?? "";
  if (publicUrl.startsWith("https://")) return true;
  if (publicUrl.startsWith("http://")) return false;

  return env.NODE_ENV === "production";
}
