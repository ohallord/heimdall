import type { ReactNode } from "react";

/** Shared empty-copy block for dashboard tables and panels. */
export function EmptyState({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="px-4 py-8 text-sm text-muted">
      <div>{children}</div>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
