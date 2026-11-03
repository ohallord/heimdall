/**
 * Global notification kill switch.
 * - Env HEIMDALL_ALERTS_PAUSED=true|1 at process start
 * - Runtime toggle via setAlertsPaused (admin API)
 *
 * State lives on globalThis: Next bundles route handlers, server components and
 * instrumentation separately, so a module-level variable would give each its own copy and
 * the button's POST would never reach the page or the dispatch path.
 */

const KEY = Symbol.for("heimdall.alertsPaused");
type Holder = { [KEY]?: { paused: boolean } };

export function readAlertsPausedFromEnv(): boolean {
  return (
    process.env.HEIMDALL_ALERTS_PAUSED === "true" ||
    process.env.HEIMDALL_ALERTS_PAUSED === "1"
  );
}

function state(): { paused: boolean } {
  const g = globalThis as Holder;
  return (g[KEY] ??= { paused: readAlertsPausedFromEnv() });
}

export function areAlertsPaused(): boolean {
  return state().paused;
}

export function setAlertsPaused(value: boolean): void {
  state().paused = value;
}
