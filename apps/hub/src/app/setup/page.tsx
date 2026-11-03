import { redirect } from "next/navigation";
import { WizardForm } from "@/components/wizard-form";
import { getSetupState, isSetupComplete } from "@/lib/db/store";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isSetupComplete()) {
    redirect("/login");
  }
  const state = await getSetupState();
  const step = (state.current_step || "org_admin") as
    | "org_admin"
    | "channels"
    | "agent_token"
    | "remotes"
    | "mfa"
    | "done";

  return <WizardForm initialStep={step === "done" ? "org_admin" : step} />;
}
