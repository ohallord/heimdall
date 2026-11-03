"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ContainerMetric } from "@/lib/db/types";
import {
  containerStateTone,
  filterContainers,
  isHeimdallStackContainer,
  truncateImageRef,
} from "@/lib/metrics/containers-display";

export type ContainersTableRow = ContainerMetric & {
  agentId?: string;
  hostname?: string;
};

type Props = {
  containers: ContainersTableRow[];
  /** When true, show Host column (fleet view). */
  showHost?: boolean;
  emptyMessage?: string;
};

export function ContainersTable({
  containers,
  showHost = false,
  emptyMessage = "No container samples yet.",
}: Props) {
  const [showStopped, setShowStopped] = useState(false);

  const visible = useMemo(
    () => filterContainers<ContainersTableRow>(containers, { showStopped }),
    [containers, showStopped],
  );

  const stoppedCount =
    containers.length -
    filterContainers<ContainersTableRow>(containers, { showStopped: false })
      .length;

  if (containers.length === 0) {
    return <p className="px-4 py-6 text-sm text-muted">{emptyMessage}</p>;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
        <p className="font-mono text-xs text-muted">
          {visible.length}/{containers.length} shown
          {stoppedCount > 0 && !showStopped
            ? ` · ${stoppedCount} stopped hidden`
            : ""}
        </p>
        <label className="inline-flex cursor-pointer items-center gap-2 font-mono text-xs text-muted">
          <input
            type="checkbox"
            className="accent-[var(--signal,#0e7490)]"
            checked={showStopped}
            onChange={(e) => setShowStopped(e.target.checked)}
          />
          Show stopped
        </label>
      </div>
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
          <tr>
            {showHost ? <th className="px-4 py-2 font-medium">Host</th> : null}
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-4 py-2 font-medium">Image</th>
            <th className="px-4 py-2 font-medium">State</th>
            <th className="px-4 py-2 font-medium">Restarts</th>
            <th className="px-4 py-2 font-medium">CPU %</th>
            <th className="px-4 py-2 font-medium">Mem % lim</th>
            <th className="px-4 py-2 font-medium">Flags</th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? (
            <tr>
              <td
                colSpan={showHost ? 8 : 7}
                className="px-4 py-6 text-sm text-muted"
              >
                No running containers. Toggle “Show stopped” to list exited ones.
              </td>
            </tr>
          ) : (
            visible.map((c) => {
              const tone = containerStateTone(c.state);
              const stack = isHeimdallStackContainer(c);
              const imageFull = c.image || "";
              const imageShort = truncateImageRef(imageFull);
              const rowKey = `${c.agentId ?? ""}-${c.id}`;
              return (
                <tr
                  key={rowKey}
                  className={`border-b border-border last:border-0 ${
                    stack ? "opacity-55" : ""
                  }`}
                >
                  {showHost ? (
                    <td className="px-4 py-3">
                      {c.agentId ? (
                        <Link
                          href={`/dashboard/hosts/${c.agentId}`}
                          className="text-signal underline"
                        >
                          {c.hostname}
                        </Link>
                      ) : (
                        c.hostname ?? "—"
                      )}
                    </td>
                  ) : null}
                  <td className="px-4 py-3 font-medium">
                    {c.name || c.id}
                    {stack ? (
                      <span className="ml-2 font-mono text-[10px] uppercase tracking-wide text-muted">
                        stack
                      </span>
                    ) : null}
                  </td>
                  <td
                    className="max-w-[14rem] truncate px-4 py-3 font-mono text-xs text-muted"
                    title={imageFull}
                  >
                    {imageShort}
                  </td>
                  <td className="px-4 py-3">
                    <StateBadge tone={tone} label={c.state || "—"} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{c.restartCount}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {c.cpuPercent != null ? Number(c.cpuPercent).toFixed(1) : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {c.memPercent != null ? Number(c.memPercent).toFixed(1) : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {[
                      c.oomKilled ? "oom" : null,
                      c.restartLoop ? "loop" : null,
                      c.state === "exited" ? "exited" : null,
                    ]
                      .filter(Boolean)
                      .join(" ") || "—"}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function StateBadge({
  tone,
  label,
}: {
  tone: ReturnType<typeof containerStateTone>;
  label: string;
}) {
  const cls =
    tone === "running"
      ? "bg-ok/15 text-ok"
      : tone === "exited"
        ? "bg-[#eef1f3] text-muted"
        : tone === "created"
          ? "bg-[#e8f0fe] text-[#1d4ed8]"
          : "text-muted";
  return (
    <span
      className={`inline-block px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}
