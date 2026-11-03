import type { ReactNode } from "react";
import { DashboardNav } from "@/components/dashboard-nav";

export function DashboardShell({
  children,
  orgName,
  userLabel,
  openAlarmsCount,
  logoutAction,
}: {
  children: ReactNode;
  orgName?: string | null;
  userLabel?: string | null;
  openAlarmsCount?: number;
  logoutAction?: () => Promise<void>;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface/90 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-6 py-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
                {orgName ?? "Heimdall"}
              </p>
              <p className="mt-1 text-sm text-muted">
                Operator console
                {userLabel ? ` · ${userLabel}` : ""}
              </p>
            </div>
            {logoutAction ? (
              <form action={logoutAction}>
                <button
                  type="submit"
                  className="border border-border px-3 py-1.5 text-sm text-muted hover:border-signal hover:text-signal"
                >
                  Sign out
                </button>
              </form>
            ) : null}
          </div>
          <DashboardNav openAlarmsCount={openAlarmsCount ?? 0} />
        </div>
      </header>
      {children}
    </div>
  );
}
