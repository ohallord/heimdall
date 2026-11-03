import { assertPublicUrl, BlockedHostError, type SafeFetchOpts } from "./safe-fetch";

export const BLOCKED_HOST_HINT =
  "Private, loopback and link-local addresses are blocked. To allow a LAN target, add its host, IP or CIDR to HEIMDALL_ALLOW_PRIVATE_HOSTS on the hub.";

/**
 * Save-time check for admin-supplied integration URLs. Returns a 400 `blocked_host` Response
 * (naming the allowlist env var) for a bad scheme or a target that resolves to a blocked address,
 * else null. A hostname that does not resolve yet is accepted: it is re-checked on every request.
 */
export async function rejectBlockedUrls(
  urls: Array<string | undefined | null>,
  opts: Pick<SafeFetchOpts, "resolve" | "allow"> = {},
): Promise<Response | null> {
  for (const raw of urls) {
    if (!raw) continue;
    try {
      await assertPublicUrl(raw, opts);
    } catch (err) {
      // DNS failure (ENOTFOUND, timeout): accept now; every request re-validates at connect time.
      if (!(err instanceof BlockedHostError) || /did not resolve/.test(err.message)) continue;
      return Response.json(
        { error: "blocked_host", detail: err.message, hint: BLOCKED_HOST_HINT, url: raw },
        { status: 400 },
      );
    }
  }
  return null;
}
