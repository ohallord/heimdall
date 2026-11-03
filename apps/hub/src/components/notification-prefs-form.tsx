"use client";

import { useState } from "react";

type Prefs = {
  notifySmtp: boolean;
  notifySlack: boolean;
  notifyDiscord: boolean;
  notifySms: boolean;
  smsPhone: string;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  timezone: string;
};

export function NotificationPrefsForm({ initial }: { initial: Prefs }) {
  const [prefs, setPrefs] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/notifications/prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notifySmtp: prefs.notifySmtp,
          notifySlack: prefs.notifySlack,
          notifyDiscord: prefs.notifyDiscord,
          notifySms: prefs.notifySms,
          smsPhone: prefs.smsPhone.trim() || null,
          quietHoursEnabled: prefs.quietHoursEnabled,
          quietStart: prefs.quietStart,
          quietEnd: prefs.quietEnd,
          timezone: prefs.timezone,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : JSON.stringify(data.error ?? res.statusText),
        );
      }
      setMessage("Preferences saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-6 border border-border bg-surface p-5">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide">
          Channels
        </h2>
        <Toggle
          label="Email (SMTP)"
          checked={prefs.notifySmtp}
          onChange={(v) => setPrefs((p) => ({ ...p, notifySmtp: v }))}
        />
        <Toggle
          label="Slack"
          checked={prefs.notifySlack}
          onChange={(v) => setPrefs((p) => ({ ...p, notifySlack: v }))}
        />
        <Toggle
          label="Discord"
          checked={prefs.notifyDiscord}
          onChange={(v) => setPrefs((p) => ({ ...p, notifyDiscord: v }))}
        />
        <Toggle
          label="SMS"
          checked={prefs.notifySms}
          onChange={(v) => setPrefs((p) => ({ ...p, notifySms: v }))}
        />
        <label className="block text-sm">
          <span className="mb-1 block font-mono text-xs uppercase tracking-wide text-muted">
            SMS phone override
          </span>
          <input
            className="w-full border border-border bg-white px-3 py-2 text-sm outline-none focus:border-signal"
            value={prefs.smsPhone}
            onChange={(e) =>
              setPrefs((p) => ({ ...p, smsPhone: e.target.value }))
            }
            placeholder="+15551234567"
          />
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide">
          Quiet hours
        </h2>
        <Toggle
          label="Enable quiet hours"
          checked={prefs.quietHoursEnabled}
          onChange={(v) => setPrefs((p) => ({ ...p, quietHoursEnabled: v }))}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="mb-1 block font-mono text-xs uppercase tracking-wide text-muted">
              Start
            </span>
            <input
              className="w-full border border-border bg-white px-3 py-2 text-sm outline-none focus:border-signal"
              value={prefs.quietStart}
              onChange={(e) =>
                setPrefs((p) => ({ ...p, quietStart: e.target.value }))
              }
              placeholder="22:00"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-mono text-xs uppercase tracking-wide text-muted">
              End
            </span>
            <input
              className="w-full border border-border bg-white px-3 py-2 text-sm outline-none focus:border-signal"
              value={prefs.quietEnd}
              onChange={(e) =>
                setPrefs((p) => ({ ...p, quietEnd: e.target.value }))
              }
              placeholder="07:00"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-mono text-xs uppercase tracking-wide text-muted">
              Timezone
            </span>
            <input
              className="w-full border border-border bg-white px-3 py-2 text-sm outline-none focus:border-signal"
              value={prefs.timezone}
              onChange={(e) =>
                setPrefs((p) => ({ ...p, timezone: e.target.value }))
              }
              placeholder="UTC"
            />
          </label>
        </div>
      </section>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {message ? <p className="text-sm text-ok">{message}</p> : null}

      <button
        type="submit"
        disabled={busy}
        className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        Save preferences
      </button>
    </form>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[var(--signal,#0d9488)]"
      />
      <span>{label}</span>
    </label>
  );
}
