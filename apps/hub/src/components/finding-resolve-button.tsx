"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function FindingResolveButton({ findingId }: { findingId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function resolve() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/v1/security/findings/${findingId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "resolved" }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof data.error === "string"
              ? data.error
              : JSON.stringify(data.error ?? res.statusText),
          );
        }
        router.push("/dashboard/security");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "resolve failed");
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={resolve}
        disabled={pending}
        className="border border-border bg-background px-4 py-2 text-sm font-medium hover:border-signal disabled:opacity-50"
      >
        {pending ? "Resolving…" : "Mark resolved"}
      </button>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
