/**
 * Minimal 5-field crontab parser and next-run calculator (minute hour day-of-month month day-of-week).
 * Supports `*`, numbers, `a-b`, `*\/n`, `a-b/n`, comma lists, and JAN–DEC / SUN–SAT names. Day-of-week
 * 7 is Sunday. When both day fields are restricted, a day matches if either does (Vixie cron).
 * Pure TS with no Node APIs, so the admin screen can preview runs client-side.
 */

export const DEFAULT_SECURITY_SYNC_CRON = "0 8 * * *";

export type CronSpec = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

type FieldDef = { name: string; min: number; max: number; names?: string[]; namesBase?: number };
const FIELDS: FieldDef[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, namesBase: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS, namesBase: 0 },
];

class CronError extends Error {
  status = 400;
}

function parseValue(raw: string, def: FieldDef): number {
  const upper = raw.toUpperCase();
  if (def.names) {
    const i = def.names.indexOf(upper);
    if (i >= 0) return i + (def.namesBase ?? 0);
  }
  if (!/^\d+$/.test(raw)) throw new CronError(`${def.name}: "${raw}" is not a number`);
  const n = Number(raw);
  if (n < def.min || n > def.max) {
    throw new CronError(`${def.name}: ${n} is outside ${def.min}-${def.max}`);
  }
  return n;
}

function parseField(text: string, def: FieldDef): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    if (!part) throw new CronError(`${def.name}: empty list item`);
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) throw new CronError(`${def.name}: "${part}" has two steps`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        throw new CronError(`${def.name}: step "${stepText}" must be a positive number`);
      }
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = def.min;
      hi = def.name === "day of week" ? 6 : def.max;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined || !a || !b) throw new CronError(`${def.name}: bad range "${range}"`);
      lo = parseValue(a, def);
      hi = parseValue(b, def);
      if (lo > hi) throw new CronError(`${def.name}: range ${range} runs backwards`);
    } else {
      lo = parseValue(range, def);
      hi = stepText !== undefined ? def.max : lo;
    }
    for (let v = lo; v <= hi; v += step) values.add(def.name === "day of week" && v === 7 ? 0 : v);
  }
  return { values, restricted: text !== "*" };
}

export function parseCron(expr: string): CronSpec {
  if (expr.trim().startsWith("@")) throw new CronError("use 5 fields, not @ shortcuts");
  const parts = expr.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new CronError(`expected 5 fields (minute hour day month weekday), got ${parts.length}`);
  }
  const f = parts.map((p, i) => parseField(p, FIELDS[i]));
  return {
    minute: f[0].values,
    hour: f[1].values,
    dayOfMonth: f[2].values,
    month: f[3].values,
    dayOfWeek: f[4].values,
    domRestricted: f[2].restricted,
    dowRestricted: f[4].restricted,
  };
}

/** Null when valid, else a short reason. */
export function validateCron(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "invalid cron";
  }
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

type Wall = { y: number; mo: number; d: number; h: number; mi: number };

function wallClock(ms: number, tz: string): Wall {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour % 24, mi: parts.minute };
}

/** Offset of `tz` from UTC at instant `ms`, in ms. */
function offsetAt(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  return asUtc - (ms - (((ms % 60_000) + 60_000) % 60_000));
}

/** The instant a wall-clock time occurs in `tz` (earliest if ambiguous), or null in a DST gap. */
function wallToInstant(w: Wall, tz: string): number | null {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  const candidates = new Set<number>();
  for (const probe of [guess - 36e5 * 14, guess, guess + 36e5 * 14]) {
    candidates.add(guess - offsetAt(probe, tz));
  }
  for (const c of [...candidates]) candidates.add(guess - offsetAt(c, tz));
  const matches = [...candidates]
    .filter((c) => {
      const b = wallClock(c, tz);
      return b.y === w.y && b.mo === w.mo && b.d === w.d && b.h === w.h && b.mi === w.mi;
    })
    .sort((a, b) => a - b);
  return matches[0] ?? null;
}

function dayMatches(spec: CronSpec, y: number, mo: number, d: number): boolean {
  if (!spec.month.has(mo)) return false;
  const dom = spec.dayOfMonth.has(d);
  const dow = spec.dayOfWeek.has(new Date(Date.UTC(y, mo - 1, d)).getUTCDay());
  if (spec.domRestricted && spec.dowRestricted) return dom || dow;
  if (spec.domRestricted) return dom;
  if (spec.dowRestricted) return dow;
  return true;
}

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

/** First run strictly after `after`, in `tz`. Null if none within ~8 years (e.g. Feb 31). */
export function nextCronRun(expr: string | CronSpec, after: Date, tz: string): Date | null {
  const spec = typeof expr === "string" ? parseCron(expr) : expr;
  const hours = sorted(spec.hour);
  const minutes = sorted(spec.minute);
  const afterMs = after.getTime();
  const start = wallClock(afterMs, tz);
  let day = Date.UTC(start.y, start.mo - 1, start.d);
  for (let i = 0; i < 366 * 8 + 2; i += 1, day += 86_400_000) {
    const dt = new Date(day);
    const y = dt.getUTCFullYear();
    const mo = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    if (!dayMatches(spec, y, mo, d)) continue;
    for (const h of hours) {
      for (const mi of minutes) {
        const at = wallToInstant({ y, mo, d, h, mi }, tz);
        if (at !== null && at > afterMs) return new Date(at);
      }
    }
  }
  return null;
}

export function nextCronRuns(expr: string, after: Date, tz: string, count: number): Date[] {
  const spec = parseCron(expr);
  const out: Date[] = [];
  let cursor = after;
  while (out.length < count) {
    const next = nextCronRun(spec, cursor, tz);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Plain-English summary for common shapes; falls back to the expression itself. */
export function describeCron(expr: string): string {
  let spec: CronSpec;
  try {
    spec = parseCron(expr);
  } catch {
    return expr;
  }
  const [mF, hF, domF, monF, dowF] = expr.trim().split(/\s+/);
  const everyMonth = monF === "*" && domF === "*";
  const minStep = /^\*\/(\d+)$/.exec(mF);
  if (minStep && hF === "*" && everyMonth && dowF === "*") return `Every ${minStep[1]} minutes`;
  const hourStep = /^\*\/(\d+)$/.exec(hF);
  if (hourStep && spec.minute.size === 1 && everyMonth && dowF === "*") {
    return `Every ${hourStep[1]} hours at minute ${[...spec.minute][0]}`;
  }
  if (spec.minute.size !== 1 || !everyMonth) return expr;
  const times = sorted(spec.hour).map((h) => `${pad(h)}:${pad([...spec.minute][0])}`);
  if (times.length > 4) return expr;
  const at = `at ${times.join(", ")}`;
  if (dowF === "*") return `Every day ${at}`;
  const dows = sorted(spec.dayOfWeek);
  const contiguous = dows.every((v, i) => i === 0 || v === dows[i - 1] + 1);
  if (dows.length > 2 && contiguous) {
    return `${DAY_NAMES[dows[0]]} to ${DAY_NAMES[dows[dows.length - 1]]} ${at}`;
  }
  return `${dows.map((d) => DAY_NAMES[d]).join(", ")} ${at}`;
}
