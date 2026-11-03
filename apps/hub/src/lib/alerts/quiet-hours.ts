export type QuietHoursInput = {
  enabled: boolean;
  start: string; // HH:MM
  end: string; // HH:MM
  timezone: string;
};

/** Minutes since local midnight for HH:MM (also accepts H:MM). */
export function parseHmToMinutes(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Returns wall-clock minutes since midnight in the given IANA timezone.
 * Falls back to UTC when the timezone is invalid.
 */
export function localMinutesNow(
  now: Date,
  timezone: string,
): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return hour * 60 + minute;
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/**
 * Quiet window may wrap midnight (e.g. 22:00–07:00).
 * Start == end means the whole day is quiet when enabled.
 */
export function isWithinQuietWindow(
  nowMinutes: number,
  startMinutes: number,
  endMinutes: number,
): boolean {
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

export function isInQuietHours(
  prefs: QuietHoursInput,
  now = new Date(),
): boolean {
  if (!prefs.enabled) return false;
  const start = parseHmToMinutes(prefs.start);
  const end = parseHmToMinutes(prefs.end);
  if (start == null || end == null) return false;
  const nowMinutes = localMinutesNow(now, prefs.timezone);
  return isWithinQuietWindow(nowMinutes, start, end);
}

/**
 * Suppress non-critical alerts when every user with quiet hours enabled
 * is currently inside their quiet window. Users without quiet hours do not
 * block delivery. If nobody has quiet hours enabled, never suppress.
 */
export function shouldSuppressForQuietHours(
  prefsList: QuietHoursInput[],
  severity: AlertSeverity = "warning",
  now = new Date(),
): boolean {
  if (severity === "critical") return false;
  const enabled = prefsList.filter((p) => p.enabled);
  if (enabled.length === 0) return false;
  return enabled.every((p) => isInQuietHours(p, now));
}

export type AlertSeverity = "info" | "warning" | "critical";
