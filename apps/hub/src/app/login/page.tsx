"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

type PublicProvider = { id: string; name: string };

function LoginInner() {
  const router = useRouter();
  const search = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaRequired, setMfaRequired] = useState(
    search.get("mfa") === "1",
  );
  const [error, setError] = useState<string | null>(
    search.get("error"),
  );
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<PublicProvider[]>([]);

  useEffect(() => {
    void fetch("/api/v1/auth/oidc/providers")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.providers)) {
          setProviders(
            data.providers.filter(
              (p: PublicProvider) => p.id && p.name,
            ),
          );
        }
      })
      .catch(() => undefined);
  }, []);

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "login failed");
      if (data.mfaRequired) {
        setMfaRequired(true);
        return;
      }
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    } finally {
      setBusy(false);
    }
  }

  async function onMfa(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/auth/mfa/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "totp", code: mfaCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "mfa failed");
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "mfa failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6 py-10">
      <header className="flex items-center gap-3">
        {/* BrandMark is a client-safe static img; login page is a client component */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/mark-light.svg" alt="" width={40} height={40} />
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
            Heimdall
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Sign in</h1>
        </div>
      </header>
      {error ? (
        <p className="border border-danger/40 bg-white px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {!mfaRequired ? (
        <>
          <form onSubmit={onLogin} className="space-y-4 border border-border bg-surface p-5">
            <label className="block text-sm">
              <span className="mb-1 block font-mono text-xs uppercase text-muted">
                Email or username
              </span>
              <input
                className="w-full border border-border px-3 py-2"
                type="text"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-mono text-xs uppercase text-muted">
                Password
              </span>
              <input
                className="w-full border border-border px-3 py-2"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              Continue
            </button>
          </form>

          {providers.length > 0 ? (
            <div className="space-y-2 border border-border bg-surface p-5">
              <p className="font-mono text-xs uppercase text-muted">
                Or continue with SSO
              </p>
              {providers.map((p) => (
                <a
                  key={p.id}
                  href={`/api/v1/auth/oidc/start?provider=${encodeURIComponent(p.id)}`}
                  className="block border border-border px-4 py-2 text-center text-sm hover:border-signal hover:text-signal"
                >
                  {p.name}
                </a>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <form onSubmit={onMfa} className="space-y-4 border border-border bg-surface p-5">
          <p className="text-sm text-muted">
            Open your authenticator app and enter the 6-digit code.
          </p>
          <label className="block text-sm">
            <span className="mb-1 block font-mono text-xs uppercase text-muted">
              Enter Authenticator Code
            </span>
            <input
              className="w-full border border-border px-3 py-2"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            Verify
          </button>
        </form>
      )}
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto flex min-h-screen w-full max-w-md items-center justify-center px-6">
          <p className="text-sm text-muted">Loading…</p>
        </main>
      }
    >
      <LoginInner />
    </Suspense>
  );
}
