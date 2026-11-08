"use client";

import { useRouter } from "next/navigation";
import { apiErrorMessage } from "@/lib/api-error";
import { useMemo, useState } from "react";

type Step =
  | "org_admin"
  | "channels"
  | "agent_token"
  | "remotes"
  | "mfa"
  | "done";

type Snippets = {
  systemd: string;
  docker: string;
  kubernetes: string;
};

export function WizardForm({ initialStep }: { initialStep: Step }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(initialStep);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [orgName, setOrgName] = useState("Heimdall Ops");
  const [adminName, setAdminName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpFrom, setSmtpFrom] = useState("");
  const [smtpTo, setSmtpTo] = useState("");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [slackUrl, setSlackUrl] = useState("");
  const [discordUrl, setDiscordUrl] = useState("");
  const [smsSid, setSmsSid] = useState("");
  const [smsToken, setSmsToken] = useState("");
  const [smsFrom, setSmsFrom] = useState("");
  const [smsTo, setSmsTo] = useState("");
  const [smsApiBase, setSmsApiBase] = useState("");

  const [setupToken, setSetupToken] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [snippets, setSnippets] = useState<Snippets | null>(null);
  const [snippetTab, setSnippetTab] = useState<keyof Snippets>("docker");

  const [githubOrg, setGithubOrg] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [gitlabPath, setGitlabPath] = useState("");
  const [gitlabToken, setGitlabToken] = useState("");

  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [, setTotpSecret] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const steps = useMemo(
    () =>
      [
        ["org_admin", "Admin"],
        ["channels", "Alerts"],
        ["agent_token", "Agent"],
        ["remotes", "Remotes"],
        ["mfa", "MFA"],
        ["done", "Done"],
      ] as const,
    [],
  );

  async function post(path: string, body?: unknown) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(apiErrorMessage(data, res.statusText));
    }
    return data;
  }

  async function submitOrgAdmin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/v1/setup/org-admin", {
        orgName,
        adminName,
        email,
        password,
        setupToken,
      });
      setStep("channels");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitChannels(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/v1/setup/channels", {
        smtp: smtpHost
          ? {
              host: smtpHost,
              port: Number(smtpPort) || 587,
              from: smtpFrom || email,
              to: smtpTo || email,
              user: smtpUser || undefined,
              pass: smtpPass || undefined,
            }
          : undefined,
        slackWebhookUrl: slackUrl,
        discordWebhookUrl: discordUrl,
        sms:
          smsSid && smsToken && smsFrom && smsTo
            ? {
                accountSid: smsSid,
                authToken: smsToken,
                from: smsFrom,
                to: smsTo,
                apiBaseUrl: smsApiBase || undefined,
              }
            : undefined,
      });
      setStep("agent_token");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function createToken() {
    setBusy(true);
    setError(null);
    try {
      const data = await post("/api/v1/setup/agent-token");
      setToken(data.token);
      setSnippets(data.snippets);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitRemotes(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/v1/setup/remotes", {
        github:
          githubOrg && githubToken
            ? { org: githubOrg, token: githubToken }
            : undefined,
        gitlab:
          gitlabPath && gitlabToken
            ? { projectPath: gitlabPath, token: gitlabToken }
            : undefined,
        skip: !(githubOrg && githubToken) && !(gitlabPath && gitlabToken),
      });
      setStep("mfa");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function startTotp() {
    setBusy(true);
    setError(null);
    try {
      const data = await post("/api/v1/auth/mfa/totp/enroll", { action: "start" });
      setTotpSecret(data.secret);
      setTotpUri(data.uri);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function confirmTotp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await post("/api/v1/auth/mfa/totp/enroll", {
        action: "confirm",
        token: totpCode,
      });
      setRecoveryCodes(data.recoveryCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await post("/api/v1/setup/complete");
      setStep("done");
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="border-b border-border pb-5">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          First-run setup
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Heimdall</h1>
        <p className="mt-2 text-sm text-muted">
          Create the admin, wire alerts, mint an agent token, optionally add
          GitHub/GitLab security tokens, then enroll MFA.
        </p>
      </header>

      <ol className="flex flex-wrap gap-3 font-mono text-xs uppercase tracking-wide">
        {steps.map(([key, label]) => (
          <li
            key={key}
            className={
              step === key ? "text-signal" : "text-muted"
            }
          >
            {label}
          </li>
        ))}
      </ol>

      {error ? (
        <p className="border border-danger/40 bg-white px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {step === "org_admin" ? (
        <form onSubmit={submitOrgAdmin} className="space-y-4 border border-border bg-surface p-5">
          <Field
            label="Organization"
            value={orgName}
            onChange={setOrgName}
            placeholder="Heimdall Ops"
          />
          <Field
            label="Admin name"
            value={adminName}
            onChange={setAdminName}
            placeholder="Ada Admin"
            required
          />
          <Field
            label="Admin email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="admin@example.com"
            required
          />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="At least 12 characters"
            required
          />
          <Field
            label="Setup token (the hub's HEIMDALL_BOOTSTRAP_TOKEN)"
            type="password"
            value={setupToken}
            onChange={setSetupToken}
            placeholder="Proves you operate this hub"
            required
          />
          <button
            type="submit"
            disabled={busy}
            className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            Continue
          </button>
        </form>
      ) : null}

      {step === "channels" ? (
        <form onSubmit={submitChannels} className="space-y-4 border border-border bg-surface p-5">
          <p className="text-sm text-muted">
            SMTP is recommended. Slack/Discord are optional webhooks. SMS uses a
            Twilio-compatible Messages API (BYO account).
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="SMTP host"
              value={smtpHost}
              onChange={setSmtpHost}
              placeholder="smtp.example.com"
            />
            <Field
              label="SMTP port"
              value={smtpPort}
              onChange={setSmtpPort}
              placeholder="587"
            />
            <Field
              label="From"
              value={smtpFrom}
              onChange={setSmtpFrom}
              placeholder="heimdall@example.com"
            />
            <Field
              label="To"
              value={smtpTo}
              onChange={setSmtpTo}
              placeholder="ops@example.com"
            />
            <Field
              label="SMTP user"
              value={smtpUser}
              onChange={setSmtpUser}
              placeholder="smtp-user"
            />
            <Field
              label="SMTP password"
              type="password"
              value={smtpPass}
              onChange={setSmtpPass}
              placeholder="SMTP password"
            />
          </div>
          <Field
            label="Slack webhook URL"
            value={slackUrl}
            onChange={setSlackUrl}
            placeholder="https://hooks.slack.com/services/…"
          />
          <Field
            label="Discord webhook URL"
            value={discordUrl}
            onChange={setDiscordUrl}
            placeholder="https://discord.com/api/webhooks/…"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="SMS Account SID"
              value={smsSid}
              onChange={setSmsSid}
              placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            />
            <Field
              label="SMS Auth Token"
              type="password"
              value={smsToken}
              onChange={setSmsToken}
              placeholder="SMS auth token"
            />
            <Field
              label="SMS From"
              value={smsFrom}
              onChange={setSmsFrom}
              placeholder="+15551234567"
            />
            <Field
              label="SMS To"
              value={smsTo}
              onChange={setSmsTo}
              placeholder="+15557654321"
            />
          </div>
          <Field
            label="SMS API base URL (optional)"
            value={smsApiBase}
            onChange={setSmsApiBase}
            placeholder="https://api.twilio.com"
          />
          <button
            type="submit"
            disabled={busy}
            className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            Save channels
          </button>
        </form>
      ) : null}

      {step === "agent_token" ? (
        <section className="space-y-4 border border-border bg-surface p-5">
          {!token ? (
            <button
              type="button"
              onClick={createToken}
              disabled={busy}
              className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              Generate first agent token
            </button>
          ) : (
            <>
              <p className="text-sm">
                Token (shown once):{" "}
                <code className="mono break-all text-foreground">{token}</code>
              </p>
              <div className="flex gap-2 font-mono text-xs uppercase">
                {(["docker", "systemd", "kubernetes"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setSnippetTab(tab)}
                    className={
                      snippetTab === tab
                        ? "border-b-2 border-signal text-signal"
                        : "text-muted"
                    }
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <pre className="overflow-x-auto border border-border bg-[#f8fafb] p-3 font-mono text-xs">
                {snippets?.[snippetTab]}
              </pre>
              <button
                type="button"
                onClick={() => setStep("remotes")}
                className="bg-signal px-4 py-2 text-sm font-medium text-white"
              >
                Continue to remotes
              </button>
            </>
          )}
        </section>
      ) : null}

      {step === "remotes" ? (
        <form onSubmit={submitRemotes} className="space-y-4 border border-border bg-surface p-5">
          <p className="text-sm text-muted">
            Optional Phase 6 remotes: GitHub org token (Dependabot / advisories)
            and GitLab project token (GraphQL vulnerabilities). Skip if you will
            only ingest Trivy/OSV reports.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="GitHub org"
              value={githubOrg}
              onChange={setGithubOrg}
              placeholder="acme-corp"
            />
            <Field
              label="GitHub token"
              type="password"
              value={githubToken}
              onChange={setGithubToken}
              placeholder="ghp_… or github_pat_…"
            />
            <Field
              label="GitLab project path"
              value={gitlabPath}
              onChange={setGitlabPath}
              placeholder="group/project"
            />
            <Field
              label="GitLab token"
              type="password"
              value={gitlabToken}
              onChange={setGitlabToken}
              placeholder="glpat-…"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            Save remotes / continue
          </button>
        </form>
      ) : null}

      {step === "mfa" ? (
        <section className="space-y-4 border border-border bg-surface p-5">
          <p className="text-sm text-muted">
            Admins must enroll an authenticator app (Google Authenticator,
            1Password, Authy, etc.). Passkeys are also available via API;
            recovery codes are issued on confirm.
          </p>
          {!totpUri ? (
            <button
              type="button"
              onClick={startTotp}
              disabled={busy}
              className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              Start authenticator enrollment
            </button>
          ) : !recoveryCodes ? (
            <form onSubmit={confirmTotp} className="space-y-3">
              <p className="break-all font-mono text-xs text-muted">{totpUri}</p>
              <Field
                label="Enter Authenticator Code"
                value={totpCode}
                onChange={setTotpCode}
                placeholder="000000"
                required
              />
              <button
                type="submit"
                disabled={busy}
                className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                Confirm authenticator code
              </button>
            </form>
          ) : (
            <div className="space-y-3">
              <p className="text-sm font-medium text-ok">MFA enrolled</p>
              <p className="text-sm text-muted">Store these recovery codes offline:</p>
              <ul className="grid grid-cols-2 gap-1 font-mono text-xs sm:grid-cols-3">
                {recoveryCodes.map((code) => (
                  <li key={code}>{code}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={finish}
                disabled={busy}
                className="bg-signal px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                Finish setup
              </button>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-mono text-xs uppercase tracking-wide text-muted">
        {label}
      </span>
      <input
        className="w-full border border-border bg-white px-3 py-2 text-sm outline-none focus:border-signal"
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
