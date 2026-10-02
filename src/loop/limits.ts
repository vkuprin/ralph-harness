import { stampMinutes } from "../lib/clock.ts";
import { plain } from "../lib/text.ts";

// resetAt: the moment the limit in a message resets, from the text claude
// prints — "hit your session limit · resets 9:10am (Europe/Paris)", "resets Mon
// 9am", "resets Oct 3, 2am" — plus a two-minute margin, since the CLI rounds the
// time. null when the text names no time this can read.
//
// A reset time that has just passed, with the limit still on, is a late reset
// and not tomorrow's: read at 3:05, "resets 3am" rolled forward would wait a
// whole day for a limit that lifts in minutes. Anything within the hour before
// now is therefore unknown, and so is anything more than eight days out.

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SHAPE =
  /^(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*,?\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d\d))?\s*([ap]m)\b(?:\s*\(([A-Za-z0-9_+/-]+)\))?/i;

export interface Reset {
  /** Seconds since the epoch. */
  epoch: number;
  /** The same moment in local time, for people. */
  at: string;
}

function validZone(zone: string): boolean {
  if (zone.includes("..")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function partsIn(ms: number, zone: string | undefined): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return {
    year: Number(p.year),
    month: Number(p.month) - 1,
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS.indexOf((p.weekday ?? "").slice(0, 3).toLowerCase()),
  };
}

/** The zone's offset from UTC at instant `ms`, in ms. */
function offsetAt(ms: number, zone: string | undefined): number {
  const p = partsIn(ms, zone);
  return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** mktime in `zone`: wall-clock fields to seconds since the epoch; days overflow as mktime's do. */
export function zonedToEpoch(year: number, month: number, day: number, hour: number, minute: number, zone?: string): number {
  const guess = Date.UTC(year, month, day, hour, minute, 0);
  const first = offsetAt(guess, zone);
  let t = guess - first;
  const second = offsetAt(t, zone);
  if (second !== first) t = guess - second;
  return Math.floor(t / 1000);
}

/** The reset named in `message`, read against `now` (seconds). */
export function resetAt(message: string, now: number): Reset | null {
  const all = [...message.matchAll(/\bresets\s+([^\n]{0,60})/gi)];
  const last = all.at(-1)?.[1];
  if (last === undefined) return null;
  const m = SHAPE.exec(last);
  if (!m) return null;
  const wd = (m[1] ?? "").toLowerCase();
  const mon = (m[2] ?? "").toLowerCase();
  const mday = m[3] === undefined ? 0 : Number(m[3]);
  let h = Number(m[4]);
  const min = m[5] === undefined ? 0 : Number(m[5]);
  const pm = m[6]!.toLowerCase() === "pm";
  const zone = m[7] !== undefined && validZone(m[7]) ? m[7] : undefined;
  if (h < 1 || h > 12 || min > 59) return null;
  h = (h % 12) + (pm ? 12 : 0);

  const n = partsIn(now * 1000, zone);
  const candidates: number[] = [];
  if (mon !== "") {
    const mi = MONTHS.indexOf(mon);
    for (const dy of [-1, 0, 1]) candidates.push(zonedToEpoch(n.year + dy, mi, mday, h, min, zone));
  } else {
    let d = 0;
    if (wd !== "") d = (((WEEKDAYS.indexOf(wd) - n.weekday) % 7) + 7) % 7;
    const step = wd !== "" ? 7 : 1;
    for (const k of [-1, 0, 1]) candidates.push(zonedToEpoch(n.year, n.month, n.day + d + k * step, h, min, zone));
  }
  if (candidates.some((c) => c <= now && c > now - 3600)) return null;
  const ahead = candidates.filter((c) => c > now).sort((a, b) => a - b);
  const t = ahead[0];
  if (t === undefined || t - now > 8 * 86400) return null;
  const epoch = t + 120;
  return { epoch, at: stampMinutes(new Date(epoch * 1000)) };
}

/** Whether any of `lines` reads as a limit, and the last one that does, as plain text. */
export function limitLine(lines: string[], pattern: RegExp): string | null {
  let found: string | null = null;
  for (const l of lines) if (pattern.test(l)) found = l;
  return found === null ? null : plain(found);
}
