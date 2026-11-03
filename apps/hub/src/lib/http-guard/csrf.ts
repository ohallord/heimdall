/**
 * Same-origin check for session-cookie mutating routes.
 * Expected origin: HEIMDALL_PUBLIC_URL, else scheme from the request URL + Host header.
 * Requests with neither Origin nor Sec-Fetch-Site (curl, server-to-server) pass: they carry no ambient browser credentials.
 */
export function assertSameOrigin(request: Request): boolean {
  const sfs = request.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "none") return false;

  const origin = request.headers.get("origin");
  if (origin === null) return true;

  let expected: string;
  const pub = process.env.HEIMDALL_PUBLIC_URL?.trim();
  if (pub) {
    try {
      expected = new URL(pub).origin;
    } catch {
      return false;
    }
  } else {
    const host = request.headers.get("host");
    if (!host) return false;
    expected = `${new URL(request.url).protocol}//${host}`;
  }
  return origin === expected;
}

export function csrfDenied(): Response {
  return new Response(JSON.stringify({ error: "csrf" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}
