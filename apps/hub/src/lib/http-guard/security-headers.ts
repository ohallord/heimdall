/**
 * Response headers for every hub route. Next.js App Router injects inline bootstrap scripts,
 * so script-src keeps 'unsafe-inline' (nonce-based CSP would need a proxy for every request);
 * the rest of the policy still blocks framing, plugins, base-tag and form hijacks, and
 * off-origin script/connect targets.
 */
export function securityHeaders(): { key: string; value: string }[] {
  const dev = process.env.NODE_ENV !== "production";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    // Browsers ignore HSTS over plain http, so this is safe on http-only LAN installs.
    { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  ];
}
