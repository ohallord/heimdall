import { assertSameOrigin, csrfDenied } from "./csrf";

/**
 * CSRF wrapper for session-cookie mutating route handlers (POST/PUT/PATCH/DELETE).
 * Rejects cross-origin browser requests with 403 before the handler runs.
 *
 * Deliberately NOT applied (token-auth, no ambient cookies; see docs/design/security-model.md):
 *   api/v1/agents/{register,heartbeat,metrics,logs,vulns}, api/v1/integrations/{unifi,runtime}/webhook,
 *   v1/metrics, v1/logs (OTLP).
 */
export function mutating<A extends unknown[]>(
  handler: (request: Request, ...rest: A) => Promise<Response>,
): (request: Request, ...rest: A) => Promise<Response> {
  return async (request, ...rest) => {
    if (!assertSameOrigin(request)) return csrfDenied();
    return handler(request, ...rest);
  };
}
