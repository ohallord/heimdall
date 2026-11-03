import { upsertFindingsDetailed } from "@/lib/security/store";
import type { NormalizedFinding } from "@/lib/security/types";
import { normalizeRuntimePayload } from "./normalize";

export type RuntimeIngestResult = {
  ok: true;
  accepted: number;
  written: number;
  alarmsRaised: number;
};

export async function ingestRuntimeWebhook(input: {
  orgId: string;
  body: unknown;
}): Promise<RuntimeIngestResult> {
  const findings: NormalizedFinding[] = normalizeRuntimePayload(input.body);
  if (findings.length === 0) {
    return {
      ok: true,
      accepted: 0,
      written: 0,
      alarmsRaised: 0,
    };
  }

  const result = await upsertFindingsDetailed(input.orgId, findings);
  return {
    ok: true,
    accepted: findings.length,
    written: result.written,
    alarmsRaised: result.alarmsRaised,
  };
}
