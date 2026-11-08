"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type UnifiState = {
  webhookPath: string;
  tokenHint: string | null;
  token?: string;
};

type OtelState = {
  metricsPath: string;
  logsPath?: string;
  tracesPath?: string;
  tokenHint: string | null;
  token?: string;
};

type RuntimeState = {
  webhookPath: string;
  tokenHint: string | null;
  token?: string;
};

type RotateKind = "unifi" | "otel" | "runtime";

export function IntegrationsForm({ canWrite }: { canWrite: boolean }) {
  const router = useRouter();
  const [unifi, setUnifi] = useState<UnifiState | null>(null);
  const [otel, setOtel] = useState<OtelState | null>(null);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [busy, setBusy] = useState<RotateKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    // Browser-only origin for webhook URL hints.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- window is unavailable during SSR init
    setOrigin(window.location.origin);
    void (async () => {
      try {
        const [u, o, r] = await Promise.all([
          fetch("/api/v1/integrations/unifi"),
          fetch("/api/v1/integrations/otel"),
          fetch("/api/v1/integrations/runtime"),
        ]);
        if (u.ok) setUnifi(await u.json());
        if (o.ok) setOtel(await o.json());
        if (r.ok) setRuntime(await r.json());
      } catch {
        setError("failed to load integrations");
      }
    })();
  }, []);

  async function rotate(kind: RotateKind) {
    if (!canWrite) return;
    setBusy(kind);
    setError(null);
    try {
      const path =
        kind === "unifi"
          ? "/api/v1/integrations/unifi"
          : kind === "otel"
            ? "/api/v1/integrations/otel"
            : "/api/v1/integrations/runtime";
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rotate: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : "rotate failed",
        );
      }
      if (kind === "unifi") setUnifi(data);
      else if (kind === "otel") setOtel(data);
      else setRuntime(data);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "rotate failed");
    } finally {
      setBusy(null);
    }
  }

  const webhookUrl = unifi
    ? `${origin}${unifi.webhookPath}`
    : `${origin}/api/v1/integrations/unifi/webhook`;
  const metricsUrl = otel
    ? `${origin}${otel.metricsPath}`
    : `${origin}/v1/metrics`;
  const logsUrl = otel
    ? `${origin}${otel.logsPath ?? "/v1/logs"}`
    : `${origin}/v1/logs`;
  const tracesUrl = `${origin}${otel?.tracesPath ?? "/v1/traces"}`;
  const runtimeUrl = runtime
    ? `${origin}${runtime.webhookPath}`
    : `${origin}/api/v1/integrations/runtime/webhook`;

  return (
    <section className="space-y-6 border border-border bg-surface p-4">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide">
          Integrations
        </h2>
        <p className="mt-1 text-xs text-muted">
          UniFi Alarm Manager webhook, OpenTelemetry OTLP metrics, logs and traces, and
          optional runtime (Falco/sidekick) ingest. Tokens are shown once on
          mint/rotate — store them in the collector env, never on argv.
        </p>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <div className="space-y-3 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">UniFi webhook</h3>
        <p className="font-mono text-xs break-all text-muted">{webhookUrl}</p>
        <p className="text-xs text-muted">
          Token hint:{" "}
          <span className="font-mono">{unifi?.tokenHint ?? "—"}</span>
        </p>
        {unifi?.token ? (
          <p className="rounded border border-border bg-[#f8fafb] px-3 py-2 font-mono text-xs break-all">
            New token (copy now): {unifi.token}
          </p>
        ) : null}
        {canWrite ? (
          <button
            type="button"
            disabled={busy === "unifi"}
            onClick={() => void rotate("unifi")}
            className="border border-border px-3 py-1.5 text-sm hover:border-signal disabled:opacity-50"
          >
            {busy === "unifi" ? "Rotating…" : "Rotate UniFi token"}
          </button>
        ) : null}
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">OTLP metrics, logs &amp; traces</h3>
        <p className="text-xs text-muted">Metrics:</p>
        <p className="font-mono text-xs break-all text-muted">{metricsUrl}</p>
        <p className="text-xs text-muted">Logs:</p>
        <p className="font-mono text-xs break-all text-muted">{logsUrl}</p>
        <p className="text-xs text-muted">Traces:</p>
        <p className="font-mono text-xs break-all text-muted">{tracesUrl}</p>
        <p className="text-xs text-muted">
          Token hint:{" "}
          <span className="font-mono">{otel?.tokenHint ?? "—"}</span>
        </p>
        {otel?.token ? (
          <p className="rounded border border-border bg-[#f8fafb] px-3 py-2 font-mono text-xs break-all">
            New token (copy now): {otel.token}
          </p>
        ) : null}
        {canWrite ? (
          <button
            type="button"
            disabled={busy === "otel"}
            onClick={() => void rotate("otel")}
            className="border border-border px-3 py-1.5 text-sm hover:border-signal disabled:opacity-50"
          >
            {busy === "otel" ? "Rotating…" : "Rotate OTEL token"}
          </button>
        ) : null}
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">Runtime webhook</h3>
        <p className="mt-1 text-xs text-muted">
          Optional Falco Sidekick (or compatible) HTTP output. Not required —
          log threat rules still run without a runtime sensor.
        </p>
        <p className="font-mono text-xs break-all text-muted">{runtimeUrl}</p>
        <p className="text-xs text-muted">
          Token hint:{" "}
          <span className="font-mono">{runtime?.tokenHint ?? "—"}</span>
        </p>
        {runtime?.token ? (
          <p className="rounded border border-border bg-[#f8fafb] px-3 py-2 font-mono text-xs break-all">
            New token (copy now): {runtime.token}
          </p>
        ) : null}
        {canWrite ? (
          <button
            type="button"
            disabled={busy === "runtime"}
            onClick={() => void rotate("runtime")}
            className="border border-border px-3 py-1.5 text-sm hover:border-signal disabled:opacity-50"
          >
            {busy === "runtime" ? "Rotating…" : "Rotate runtime token"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
