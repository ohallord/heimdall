import { redirect } from "next/navigation";
import { RemotesForm } from "@/components/remotes-form";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete } from "@/lib/db/store";
import { can } from "@/lib/rbac/permissions";
import { listSecurityConnections } from "@/lib/security/store";

export const dynamic = "force-dynamic";

export default async function RemotesPage() {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const connections = session.orgId
    ? await listSecurityConnections(session.orgId)
    : [];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Security · Remotes
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Git remotes
        </h1>
        <p className="mt-2 text-sm text-muted">
          Connect N GitHub organizations and GitLab projects for vulnerability
          sync. Wizard still collects the first pair; add more here anytime.
        </p>
      </header>

      <RemotesForm
        canWrite={can(session.role!, "settings:write")}
        initial={connections.map((c) => ({
          id: c.id,
          kind: c.kind,
          name: c.name,
          tokenHint: c.token_hint,
          enabled: c.enabled,
          config: (() => {
            try {
              const parsed = JSON.parse(c.config_json) as Record<
                string,
                unknown
              >;
              delete parsed.token;
              return parsed;
            } catch {
              return {};
            }
          })(),
        }))}
      />
    </main>
  );
}
