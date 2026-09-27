import { readFileSync } from "node:fs";

// The one seam the test suite has into the harness's sense of time. A suspend
// cannot be waited for and a night cannot be waited for, so the suite moves the
// clock instead: RALPH_TEST_CLOCK names a file holding seconds to add to it, and
// RALPH_TEST_HOUR a file holding the hour of the day. Both are unset outside the
// suite, and then this is Date and nothing else. The file is read on every call
// because the suite moves it while the loop runs.
function fromFile(variable: string): number | null {
  const file = process.env[variable];
  if (!file) return null;
  try {
    const n = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Whole seconds since the epoch, as `date +%s` reads it. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000) + (fromFile("RALPH_TEST_CLOCK") ?? 0);
}

/** The local hour, 0 to 23. */
export function hour(): number {
  return fromFile("RALPH_TEST_HOUR") ?? new Date().getHours();
}

const two = (n: number) => String(n).padStart(2, "0");

/** Local time as `YYYY-MM-DD HH:MM:SS`, the stamp every log line and results row carries. */
export function stamp(d: Date = new Date()): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Local time as `YYYY-MM-DD HH:MM`. */
export function stampMinutes(d: Date = new Date()): string {
  return stamp(d).slice(0, 16);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
