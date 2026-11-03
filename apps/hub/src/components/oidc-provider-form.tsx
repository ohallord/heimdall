"use client";

import { useRouter } from "next/navigation";
import { apiErrorMessage } from "@/lib/api-error";
import { useState } from "react";

export type OidcProviderView = {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  scopes: string;
  enabled: boolean;
};

export function OidcProviderForm({
  initial,
}: {
  initial: OidcProviderView[];
}) {
  const router = useRouter();
  const [providers, setProviders] = useState(initial);
  const [name, setName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState("openid profile email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/auth/oidc/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          issuer,
          clientId,
          clientSecret,
          scopes,
          enabled: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(apiErrorMessage(data, "save failed"));
      }
      setMessage(`Saved IdP ${data.provider.name}`);
      setClientSecret("");
      const list = await fetch("/api/v1/auth/oidc/providers");
      const listed = await list.json();
      if (list.ok) setProviders(listed.providers);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            OIDC providers
          </h2>
          <p className="mt-1 text-xs text-muted">
            Bring your own IdP (Keycloak, Authentik, Okta, Google, …). Callback:{" "}
            <code className="font-mono">/api/v1/auth/oidc/callback</code>
          </p>
        </div>
        {providers.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">
            No providers configured. Local users + MFA still work.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {providers.map((p) => (
              <li key={p.id} className="px-4 py-3 text-sm">
                <span className="font-medium">{p.name}</span>
                <span className="ml-2 font-mono text-xs text-muted">
                  {p.issuer}
                </span>
                {p.enabled ? "" : " (off)"}
              </li>
            ))}
          </ul>
        )}
      </section>

      <form
        onSubmit={onSubmit}
        className="space-y-3 border border-border bg-surface p-4"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide">
          Add / update provider
        </h2>
        <label className="block text-sm">
          <span className="mb-1 block font-mono text-xs uppercase text-muted">
            Name
          </span>
          <input
            className="w-full border border-border px-3 py-2 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="company-sso"
            required
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-mono text-xs uppercase text-muted">
            Issuer URL
          </span>
          <input
            className="w-full border border-border px-3 py-2 font-mono text-sm"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            placeholder="https://idp.example.com/realms/heimdall"
            required
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-mono text-xs uppercase text-muted">
            Client ID
          </span>
          <input
            className="w-full border border-border px-3 py-2 font-mono text-sm"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            required
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-mono text-xs uppercase text-muted">
            Client secret
          </span>
          <input
            className="w-full border border-border px-3 py-2 font-mono text-sm"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            required
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-mono text-xs uppercase text-muted">
            Scopes
          </span>
          <input
            className="w-full border border-border px-3 py-2 font-mono text-sm"
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          Save provider
        </button>
      </form>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {message ? <p className="text-sm text-ok">{message}</p> : null}
    </div>
  );
}
