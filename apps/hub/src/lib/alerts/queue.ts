import type { AlertChannelRow, NotificationPrefsRow } from "@/lib/db/types";
import type { AlertPayload, ChannelSendResult } from "./channels";
import { dispatchAlert } from "./engine";
import { areAlertsPaused } from "./pause";

export type EnqueueAlertInput = {
  channels: AlertChannelRow[];
  payload: AlertPayload;
  prefs?: NotificationPrefsRow[];
};

/**
 * Fire-and-forget notification send. Never awaited on the metrics/logs path.
 * Respects the global pause kill switch.
 */
export function enqueueAlert(input: EnqueueAlertInput): void {
  if (areAlertsPaused()) return;
  void dispatchAlert(input.channels, input.payload, {
    prefs: input.prefs,
  }).catch((err) => {
    console.error(
      "[heimdall] async alert dispatch failed:",
      err instanceof Error ? err.message : err,
    );
  });
}

/** Test helper: await the same path as enqueue (still honors pause). */
export async function enqueueAlertAndWait(
  input: EnqueueAlertInput,
): Promise<ChannelSendResult[] | "paused"> {
  if (areAlertsPaused()) return "paused";
  return dispatchAlert(input.channels, input.payload, { prefs: input.prefs });
}
