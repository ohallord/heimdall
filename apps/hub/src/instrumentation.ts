/** Server start hooks: retention purge (Phase 25), the insecure bootstrap token warning (Phase 32), and the security sync schedule. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Phase 32: shout once if the hub accepts the dev default (or a short) bootstrap token.
  setTimeout(() => {
    import("@/lib/agents/bootstrap")
      .then(({ bootstrapStatus }) => bootstrapStatus())
      .then((s) => {
        if (s.weak) {
          console.warn(
            "[heimdall] SECURITY: the bootstrap token is the well-known dev default or shorter than 24 chars; " +
              "anyone can register agents. Rotate or disable it in Settings → Agents.",
          );
        }
      })
      .catch(() => {});
  }, 5_000).unref?.();

  // Scheduled GitHub/GitLab remote security sync (per-org cron, Dashboard → Admin).
  if (process.env.HEIMDALL_DISABLE_SECURITY_SYNC_JOB !== "1") {
    import("@/lib/security/schedule")
      .then(({ startSecuritySyncScheduler }) => startSecuritySyncScheduler())
      .catch((err) => console.error("[security-sync] scheduler failed to start", err));
  }

  if (process.env.HEIMDALL_DISABLE_PURGE_JOB === "1") return;
  const { purgeAllOrgs } = await import("@/lib/metrics/retention");
  const run = () =>
    purgeAllOrgs().catch((err) => console.error("retention purge failed", err));
  setInterval(run, 6 * 60 * 60 * 1000).unref?.();
  setTimeout(run, 60_000).unref?.();
}
