"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export type HistoryPoint = { t: string; v: number };

const PRESETS = [
  { id: "1h", label: "1h", ms: 3600_000 },
  { id: "24h", label: "24h", ms: 86400_000 },
  { id: "7d", label: "7d", ms: 7 * 86400_000 },
  { id: "30d", label: "30d", ms: 30 * 86400_000 },
] as const;

type Props = {
  agentId: string;
  metric: "cpu" | "memory" | "disk";
  mount?: string;
  title: string;
  retentionDays: number;
  initialPoints?: HistoryPoint[];
};

export function MetricHistoryChart({
  agentId,
  metric,
  mount,
  title,
  retentionDays,
  initialPoints = [],
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [points, setPoints] = useState<HistoryPoint[]>(initialPoints);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rangeMs, setRangeMs] = useState(86400_000);

  const retentionMs = retentionDays * 86400_000;

  const data = useMemo(() => {
    const xs = points.map((p) => Math.floor(new Date(p.t).getTime() / 1000));
    const ys = points.map((p) => p.v);
    return [xs, ys] as uPlot.AlignedData;
  }, [points]);

  async function loadRange(ms: number) {
    const capped = Math.min(ms, retentionMs);
    setRangeMs(capped);
    setBusy(true);
    setError(null);
    const to = new Date();
    const from = new Date(to.getTime() - capped);
    const params = new URLSearchParams({
      metric,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    if (metric === "disk") params.set("mount", mount || "/");
    try {
      const res = await fetch(
        `/api/v1/agents/${agentId}/metrics/history?${params}`,
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof body.error === "string" ? body.error : res.statusText,
        );
      }
      setPoints(body.points ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // Defer so the load's state updates do not run synchronously inside the effect.
    const id = setTimeout(() => void loadRange(rangeMs), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial + metric/mount
  }, [agentId, metric, mount]);

  useEffect(() => {
    if (!rootRef.current) return;
    plotRef.current?.destroy();
    plotRef.current = null;
    if (data[0].length === 0) return;

    const opts: uPlot.Options = {
      width: rootRef.current.clientWidth || 640,
      height: 280,
      title,
      series: [
        {},
        {
          stroke: "#0f766e",
          width: 2,
          label: title,
        },
      ],
      scales: {
        x: { time: true },
        y: { auto: true },
      },
      axes: [
        { stroke: "#64748b", grid: { stroke: "#e2e8f0" } },
        { stroke: "#64748b", grid: { stroke: "#e2e8f0" }, size: 50 },
      ],
      cursor: {
        drag: { x: true, y: false, setScale: true },
      },
    };
    plotRef.current = new uPlot(opts, data, rootRef.current);

    const onResize = () => {
      if (!rootRef.current || !plotRef.current) return;
      plotRef.current.setSize({
        width: rootRef.current.clientWidth || 640,
        height: 280,
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [data, title]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => {
          const disabled = p.ms > retentionMs && p.id === "30d" && retentionDays < 30;
          const overRetention = p.ms > retentionMs;
          return (
            <button
              key={p.id}
              type="button"
              disabled={busy || overRetention}
              onClick={() => void loadRange(p.ms)}
              className={`border px-3 py-1 text-xs font-mono uppercase tracking-wide ${
                rangeMs === Math.min(p.ms, retentionMs)
                  ? "border-signal text-signal"
                  : "border-border text-muted hover:border-signal hover:text-signal"
              } disabled:opacity-40`}
              title={
                overRetention
                  ? `Retention is ${retentionDays}d`
                  : disabled
                    ? undefined
                    : p.label
              }
            >
              {p.label}
            </button>
          );
        })}
        {busy ? (
          <span className="font-mono text-xs text-muted">Loading…</span>
        ) : null}
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {points.length === 0 && !busy ? (
        <p className="text-sm text-muted">No samples in this range.</p>
      ) : (
        <div ref={rootRef} className="w-full border border-border bg-surface p-2" />
      )}
      <p className="font-mono text-xs text-muted">
        Drag horizontally to zoom · retention {retentionDays}d · {points.length}{" "}
        points
      </p>
    </div>
  );
}
