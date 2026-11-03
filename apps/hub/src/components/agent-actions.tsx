"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Props = { agentId: string; hostname: string; revoked: boolean };

/** Revoke / re-enroll buttons. Two-step: the first click arms, the second confirms. */
export function AgentActions({ agentId, hostname, revoked }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [armed, setArmed] = useState<"revoke" | "reenroll" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(action: "revoke" | "reenroll") {
    if (armed !== action) {
      setArmed(action);
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/v1/agents/${agentId}/${action}`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : res.statusText);
        setArmed(null);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : `${action} failed`);
      }
    });
  }

  const btn = "border border-border bg-background px-2 py-1 text-xs hover:border-signal disabled:opacity-50";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {!revoked ? (
          <button
            type="button"
            className={btn}
            disabled={pending}
            onClick={() => run("revoke")}
            title={`Stop accepting data from ${hostname}`}
          >
            {armed === "revoke" ? "Confirm revoke" : "Revoke"}
          </button>
        ) : null}
        <button
          type="button"
          className={btn}
          disabled={pending}
          onClick={() => run("reenroll")}
          title="Clear this agent's secret so the host can register again and get a new one"
        >
          {armed === "reenroll" ? "Confirm re-enroll" : "Re-enroll"}
        </button>
        {armed ? (
          <button type="button" className={btn} disabled={pending} onClick={() => setArmed(null)}>
            Cancel
          </button>
        ) : null}
      </div>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
