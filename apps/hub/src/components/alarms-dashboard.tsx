"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { EmptyState } from "@/components/empty-state";
import type { SerializedAlertEvent } from "@/lib/alerts/serialize";
import { MUTE_PRESETS_MINUTES } from "@/lib/alerts/fingerprint";

type Tab = "open" | "history";

function durationLabel(fromIso: string, toIso: string): string {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Status pill: Recovered (green) / Cleared (dismissed) / Muted / Open. */
function StatusBadge({ event }: { event: SerializedAlertEvent }) {
  const base =
    "inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide";
  switch (event.status) {
    case "resolved":
      return (
        <span className={`${base} border-ok/40 bg-ok/10 text-ok`}>
          ✓ Recovered
        </span>
      );
    case "dismissed":
      return (
        <span className={`${base} border-border bg-[#f4f6f8] text-muted`}>
          Cleared
        </span>
      );
    case "muted":
      return (
        <span className={`${base} border-border bg-[#f4f6f8] text-muted`}>
          Muted
        </span>
      );
    default:
      return (
        <span
          className={`${base} ${
            event.severity === "critical"
              ? "border-danger/40 bg-danger/5 text-danger"
              : "border-warn/40 bg-warn/5 text-warn"
          }`}
        >
          Open
        </span>
      );
  }
}

type Props = {
  openEvents: SerializedAlertEvent[];
  historyEvents: SerializedAlertEvent[];
  selectedId?: string;
  /** Prefer open queue when `status=open`; history when `tab=history`. */
  initialTab?: Tab;
  canWrite: boolean;
  alertsPaused: boolean;
};

export function AlarmsDashboard({
  openEvents,
  historyEvents,
  selectedId,
  initialTab,
  canWrite,
  alertsPaused,
}: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(() => {
    if (initialTab) return initialTab;
    if (selectedId && !openEvents.some((e) => e.id === selectedId)) {
      return "history";
    }
    return "open";
  });
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [bulkDays, setBulkDays] = useState(7);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);

  const [renderedAt] = useState(() => Date.now());
  const bulkCount = useMemo(() => {
    const cutoff = renderedAt - bulkDays * 86_400_000;
    return openEvents.filter((e) => new Date(e.createdAt).getTime() <= cutoff)
      .length;
  }, [openEvents, bulkDays, renderedAt]);

  function bulkDismiss() {
    startTransition(async () => {
      try {
        setError(null);
        const res = await fetch("/api/v1/alerts/dismiss-bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ olderThanDays: bulkDays }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof data.error === "string" ? data.error : "bulk dismiss failed",
          );
        }
        setBulkMsg(`Dismissed ${data.dismissed} alert(s).`);
        setBulkConfirm(false);
        router.push("/dashboard/alerts");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "bulk dismiss failed");
      }
    });
  }

  const list = tab === "open" ? openEvents : historyEvents;
  const selected = useMemo(() => {
    const fromList = list.find((e) => e.id === selectedId);
    if (fromList) return fromList;
    return (
      openEvents.find((e) => e.id === selectedId) ??
      historyEvents.find((e) => e.id === selectedId) ??
      null
    );
  }, [list, openEvents, historyEvents, selectedId]);

  function select(id: string) {
    const params = new URLSearchParams();
    params.set("id", id);
    if (tab === "history") params.set("tab", "history");
    router.push(`/dashboard/alerts?${params.toString()}`);
  }

  async function act(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<void> {
    setError(null);
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : JSON.stringify(data.error ?? res.statusText),
      );
    }
  }

  function mute(minutes: number) {
    if (!selected) return;
    startTransition(async () => {
      try {
        await act(`/api/v1/alerts/${selected.id}/mute`, { minutes });
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "mute failed");
      }
    });
  }

  function dismiss() {
    if (!selected) return;
    startTransition(async () => {
      try {
        await act(`/api/v1/alerts/${selected.id}/dismiss`);
        router.push("/dashboard/alerts");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "dismiss failed");
      }
    });
  }

  function unmute() {
    if (!selected) return;
    startTransition(async () => {
      try {
        await act(`/api/v1/alerts/${selected.id}/unmute`);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "unmute failed");
      }
    });
  }

  async function togglePause() {
    setPauseBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/alerts/pause", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused: !alertsPaused }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          typeof data.error === "string" ? data.error : "pause failed",
        );
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "pause failed");
    } finally {
      setPauseBusy(false);
    }
  }

  const payload = selected?.payload;
  const payloadObj =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex border border-border">
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium ${
              tab === "open" ? "bg-signal text-white" : "bg-surface text-ink"
            }`}
            onClick={() => {
              setTab("open");
              router.push(
                selectedId
                  ? `/dashboard/alerts?id=${encodeURIComponent(selectedId)}`
                  : "/dashboard/alerts",
              );
            }}
          >
            Open ({openEvents.length})
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium ${
              tab === "history" ? "bg-signal text-white" : "bg-surface text-ink"
            }`}
            onClick={() => {
              setTab("history");
              router.push(
                selectedId
                  ? `/dashboard/alerts?tab=history&id=${encodeURIComponent(selectedId)}`
                  : "/dashboard/alerts?tab=history",
              );
            }}
          >
            History
          </button>
        </div>
        {canWrite ? (
          <button
            type="button"
            disabled={pauseBusy}
            onClick={() => void togglePause()}
            className="border border-border bg-surface px-3 py-2 text-xs font-mono uppercase tracking-wide"
          >
            {alertsPaused ? "Resume alerts" : "Pause alerts"}
          </button>
        ) : null}
        {canWrite && tab === "open" ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="font-mono text-xs uppercase text-muted" htmlFor="bulk-age">
              Dismiss older than
            </label>
            <select
              id="bulk-age"
              value={bulkDays}
              onChange={(e) => {
                setBulkDays(Number(e.target.value));
                setBulkConfirm(false);
              }}
              className="border border-border bg-surface px-2 py-2 text-xs font-mono"
            >
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={0}>All open</option>
            </select>
            {bulkConfirm ? (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={bulkDismiss}
                  className="border border-danger/40 bg-danger/5 px-3 py-2 font-mono text-xs uppercase text-danger"
                >
                  Confirm dismiss {bulkCount}
                </button>
                <button
                  type="button"
                  onClick={() => setBulkConfirm(false)}
                  className="px-2 py-2 font-mono text-xs uppercase text-muted"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={pending || bulkCount === 0}
                onClick={() => setBulkConfirm(true)}
                className="border border-border bg-surface px-3 py-2 font-mono text-xs uppercase tracking-wide disabled:opacity-50"
              >
                Dismiss {bulkCount}
              </button>
            )}
          </div>
        ) : null}
        {bulkMsg ? (
          <span className="font-mono text-xs text-muted">{bulkMsg}</span>
        ) : null}
        {alertsPaused ? (
          <span className="font-mono text-xs uppercase text-warn">
            Global pause on
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section className="border border-border bg-surface">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide">
              {tab === "open" ? "Open alarms" : "History"}
            </h2>
          </div>
          {list.length === 0 ? (
            <EmptyState
              action={
                tab === "open" ? (
                  <button
                    type="button"
                    className="text-signal underline"
                    onClick={() => {
                      setTab("history");
                      router.push("/dashboard/alerts?tab=history");
                    }}
                  >
                    View history
                  </button>
                ) : undefined
              }
            >
              {tab === "open"
                ? "Queue is clear."
                : "No alert events yet."}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {list.map((e) => {
                const active = e.id === selected?.id;
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => select(e.id)}
                      className={`flex w-full flex-col gap-1 px-4 py-3 text-left text-sm hover:bg-[#f8fafb] ${
                        active ? "bg-[#eef7f8]" : ""
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge event={e} />
                        <span
                          className={`font-mono text-xs ${
                            e.severity === "critical"
                              ? "text-danger"
                              : "text-warn"
                          }`}
                        >
                          {e.severity}
                        </span>
                        <span className="font-mono text-xs text-muted">
                          {new Date(e.createdAt).toISOString()}
                        </span>
                        {e.status === "resolved" && e.resolvedAt ? (
                          <span className="font-mono text-xs text-ok">
                            recovered after {durationLabel(e.createdAt, e.resolvedAt)}
                          </span>
                        ) : null}
                      </div>
                      <span
                        className={`line-clamp-2 ${
                          e.status === "resolved" || e.status === "dismissed"
                            ? "text-muted"
                            : ""
                        }`}
                      >
                        {e.message}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="border border-border bg-surface">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide">
              Detail
            </h2>
          </div>
          {!selected ? (
            <EmptyState>
              Select an alarm to inspect payload and take action.
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-4 px-4 py-4 text-sm">
              {selected.status === "resolved" ? (
                <div className="border border-ok/40 bg-ok/10 px-3 py-2 text-ok">
                  <p className="font-semibold">✓ Recovered</p>
                  <p className="font-mono text-xs">
                    {selected.resolvedAt
                      ? `Cleared automatically at ${new Date(selected.resolvedAt).toISOString()} after ${durationLabel(selected.createdAt, selected.resolvedAt)}.`
                      : "Cleared automatically when the host recovered."}
                  </p>
                </div>
              ) : selected.status === "dismissed" ? (
                <div className="border border-border bg-[#f4f6f8] px-3 py-2 text-muted">
                  <p className="font-semibold">Cleared manually</p>
                  {selected.dismissedAt ? (
                    <p className="font-mono text-xs">
                      Dismissed at {new Date(selected.dismissedAt).toISOString()}.
                    </p>
                  ) : null}
                </div>
              ) : null}
              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
                <dt className="font-mono text-xs uppercase text-muted">
                  Severity
                </dt>
                <dd className="font-mono text-xs">{selected.severity}</dd>
                <dt className="font-mono text-xs uppercase text-muted">
                  Status
                </dt>
                <dd className="flex flex-wrap items-center gap-2 font-mono text-xs">
                  <StatusBadge event={selected} />
                  {selected.mutedUntil
                    ? ` · until ${new Date(selected.mutedUntil).toISOString()}`
                    : ""}
                </dd>
                <dt className="font-mono text-xs uppercase text-muted">When</dt>
                <dd className="font-mono text-xs">
                  {new Date(selected.createdAt).toISOString()}
                </dd>
                <dt className="font-mono text-xs uppercase text-muted">
                  Message
                </dt>
                <dd>{selected.message}</dd>
                {selected.ruleId ? (
                  <>
                    <dt className="font-mono text-xs uppercase text-muted">
                      Rule
                    </dt>
                    <dd className="font-mono text-xs">{selected.ruleId}</dd>
                  </>
                ) : null}
                {typeof payloadObj?.hostname === "string" ? (
                  <>
                    <dt className="font-mono text-xs uppercase text-muted">
                      Host
                    </dt>
                    <dd>
                      {typeof payloadObj.agentId === "string" ? (
                        <Link
                          href={`/dashboard/hosts/${payloadObj.agentId}`}
                          className="text-signal underline"
                        >
                          {payloadObj.hostname}
                        </Link>
                      ) : (
                        payloadObj.hostname
                      )}
                    </dd>
                  </>
                ) : null}
                {typeof payloadObj?.source === "string" ? (
                  <>
                    <dt className="font-mono text-xs uppercase text-muted">
                      Source
                    </dt>
                    <dd className="font-mono text-xs">{payloadObj.source}</dd>
                  </>
                ) : null}
                {typeof payloadObj?.mountPath === "string" ? (
                  <>
                    <dt className="font-mono text-xs uppercase text-muted">
                      Mount
                    </dt>
                    <dd className="font-mono text-xs">{payloadObj.mountPath}</dd>
                  </>
                ) : null}
              </dl>

              {canWrite && selected.status !== "dismissed" &&
              selected.status !== "resolved" ? (
                <div className="flex flex-col gap-2 border-t border-border pt-4">
                  <p className="font-mono text-xs uppercase text-muted">
                    Actions {pending ? "· working…" : ""}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {MUTE_PRESETS_MINUTES.map((m) => (
                      <button
                        key={m}
                        type="button"
                        disabled={pending}
                        onClick={() => mute(m)}
                        className="border border-border bg-surface px-2 py-1 font-mono text-xs"
                      >
                        Mute {m}m
                      </button>
                    ))}
                    {selected.status === "muted" ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => unmute()}
                        className="border border-border bg-surface px-2 py-1 font-mono text-xs"
                      >
                        Unmute
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => dismiss()}
                      className="border border-danger/40 bg-danger/5 px-2 py-1 font-mono text-xs text-danger"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="border-t border-border pt-4">
                <p className="mb-2 font-mono text-xs uppercase text-muted">
                  Payload
                </p>
                <pre className="overflow-x-auto bg-[#f8fafb] p-3 font-mono text-xs leading-relaxed">
                  {JSON.stringify(selected.payload, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
