"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DEFAULT_LOG_RULES } from "@/lib/logs/rules";

export function LogSearchForm({
  initialQ,
  initialRule,
  initialMatchesOnly,
}: {
  initialQ: string;
  initialRule: string;
  initialMatchesOnly: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initialQ);
  const [rule, setRule] = useState(initialRule);
  const [matchesOnly, setMatchesOnly] = useState(initialMatchesOnly);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (rule) params.set("rule", rule);
    if (matchesOnly) params.set("matchesOnly", "1");
    const qs = params.toString();
    router.push(qs ? `/dashboard/logs?${qs}` : "/dashboard/logs");
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 border border-border bg-surface p-4 sm:flex-row sm:items-end"
    >
      <label className="block flex-1 text-sm">
        <span className="mb-1 block font-mono text-xs uppercase tracking-wide text-muted">
          Search text
        </span>
        <input
          className="w-full border border-border bg-white px-3 py-2 text-sm outline-hidden focus:border-signal"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="password, xmrig, /dev/tcp…"
        />
      </label>
      <label className="block text-sm sm:w-56">
        <span className="mb-1 block font-mono text-xs uppercase tracking-wide text-muted">
          Rule
        </span>
        <select
          className="w-full border border-border bg-white px-3 py-2 text-sm outline-hidden focus:border-signal"
          value={rule}
          onChange={(e) => setRule(e.target.value)}
        >
          <option value="">Any</option>
          {DEFAULT_LOG_RULES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 pb-2 text-sm">
        <input
          type="checkbox"
          checked={matchesOnly}
          onChange={(e) => setMatchesOnly(e.target.checked)}
        />
        Matches only
      </label>
      <button
        type="submit"
        className="bg-signal px-4 py-2 text-sm font-medium text-white"
      >
        Search
      </button>
    </form>
  );
}
