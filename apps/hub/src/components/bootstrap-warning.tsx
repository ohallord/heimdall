import Link from "next/link";
import { bootstrapStatus } from "@/lib/agents/bootstrap";

/** Admin-only banner while the hub accepts the dev default (or a short) bootstrap token. */
export async function BootstrapWarning({ role }: { role: string | undefined }) {
  if (role !== "admin") return null;
  const status = await bootstrapStatus();
  if (!status.weak) return null;
  return (
    <div role="alert" className="border border-danger bg-danger/5 px-4 py-3 text-sm text-danger">
      <strong>Insecure bootstrap token.</strong> This hub accepts the well-known development
      token (or a short one), so anyone can register agents.{" "}
      <Link href="/dashboard/settings#agents" className="underline">
        Rotate or disable it in Settings → Agents
      </Link>
      .
    </div>
  );
}
