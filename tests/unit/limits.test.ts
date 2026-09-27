import { describe, expect, test } from "bun:test";
import { limitLine, resetAt } from "../../src/loop/limits.ts";
import { DEFAULT_RATE_LIMIT_RE } from "../../src/lib/config.ts";

const utc = (...a: [number, number, number, number, number]) => Date.UTC(...a) / 1000;
const MARGIN = 120;

describe("resetAt reads the time a limit lifts", () => {
  test("an hour in a named zone, later today", () => {
    expect(resetAt("You've hit your limit · resets 3am (UTC)", utc(2026, 8, 28, 1, 0))?.epoch).toBe(utc(2026, 8, 28, 3, 0) + MARGIN);
  });
  test("minutes, and a zone that is not UTC", () => {
    // 06:00Z is 08:00 in Paris (CEST); 9:10 Paris is 07:10Z.
    expect(resetAt("hit your session limit · resets 9:10am (Europe/Paris)", utc(2026, 8, 28, 6, 0))?.epoch).toBe(
      utc(2026, 8, 28, 7, 10) + MARGIN,
    );
  });
  test("a weekday: the next one", () => {
    // 2026-09-27 is a Sunday.
    expect(resetAt("Weekly limit reached · resets Mon 9am (UTC)", utc(2026, 8, 27, 12, 0))?.epoch).toBe(utc(2026, 8, 28, 9, 0) + MARGIN);
  });
  test("a month and a day", () => {
    expect(resetAt("resets Oct 3, 2am (UTC)", utc(2026, 8, 28, 1, 0))?.epoch).toBe(utc(2026, 9, 3, 2, 0) + MARGIN);
  });
  test("'at' between the date and the hour", () => {
    expect(resetAt("resets Oct 3 at 2am (UTC)", utc(2026, 8, 28, 1, 0))?.epoch).toBe(utc(2026, 9, 3, 2, 0) + MARGIN);
  });
  test("12am is midnight and 12pm is noon", () => {
    expect(resetAt("resets 12am (UTC)", utc(2026, 8, 28, 1, 0))?.epoch).toBe(utc(2026, 8, 29, 0, 0) + MARGIN);
    expect(resetAt("resets 12pm (UTC)", utc(2026, 8, 28, 1, 0))?.epoch).toBe(utc(2026, 8, 28, 12, 0) + MARGIN);
  });
  test("a time that has just gone by is a late reset, not tomorrow's", () => {
    expect(resetAt("resets 1am (UTC)", utc(2026, 8, 28, 1, 5))).toBeNull();
  });
  test("a time more than an hour gone is tomorrow's", () => {
    expect(resetAt("resets 1am (UTC)", utc(2026, 8, 28, 3, 0))?.epoch).toBe(utc(2026, 8, 29, 1, 0) + MARGIN);
  });
  test("more than eight days out is not believed", () => {
    expect(resetAt("resets Dec 25, 2am (UTC)", utc(2026, 8, 28, 1, 0))).toBeNull();
  });
  test("the last 'resets' in the message is the one", () => {
    expect(resetAt("resets 3am (UTC)\nthen: resets 5am (UTC)", utc(2026, 8, 28, 1, 0))?.epoch).toBe(utc(2026, 8, 28, 5, 0) + MARGIN);
  });
  test("an hour that is not one is not read", () => {
    expect(resetAt("resets 13pm (UTC)", utc(2026, 8, 28, 1, 0))).toBeNull();
    expect(resetAt("resets 3:75am (UTC)", utc(2026, 8, 28, 1, 0))).toBeNull();
  });
  test("a message that names no time is not read", () => {
    expect(resetAt("Credit balance is too low", utc(2026, 8, 28, 1, 0))).toBeNull();
    expect(resetAt("", utc(2026, 8, 28, 1, 0))).toBeNull();
  });
  test("a zone that is not one falls back to the local zone rather than failing", () => {
    expect(resetAt("resets 3am (Mars/Olympus_Mons)", utc(2026, 8, 28, 1, 0))).not.toBeNull();
    expect(resetAt("resets 3am (../../etc/passwd)", utc(2026, 8, 28, 1, 0))).not.toBeNull();
  });
  test("a time that does not exist on a DST day still reads as one within the day", () => {
    const now = utc(2026, 2, 8, 5, 0); // midnight in New York, the morning clocks spring forward
    const r = resetAt("resets 2:30am (America/New_York)", now);
    expect(r).not.toBeNull();
    expect(r!.epoch - now).toBeLessThan(86400);
  });
  test("the 'at' it reports is the same moment in local time", () => {
    const r = resetAt("resets 3am (UTC)", utc(2026, 8, 28, 1, 0))!;
    expect(r.at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(new Date(`${r.at.replace(" ", "T")}:00`).getTime() / 1000).toBe(r.epoch);
  });
});

describe("limitLine", () => {
  const re = new RegExp(DEFAULT_RATE_LIMIT_RE, "i");
  test("the last line that reads as a limit", () => {
    expect(limitLine(["working", "You've hit your limit · resets 3am", "Weekly limit reached"], re)).toBe("Weekly limit reached");
  });
  test("an API 429 is a limit, a 429 in an audit finding is not", () => {
    expect(limitLine(["API Error: 429 rate limited"], re)).not.toBeNull();
    expect(limitLine(["upstream returned HTTP 429 on /login"], re)).toBeNull();
  });
  test("case does not matter", () => {
    expect(limitLine(["CREDIT BALANCE IS TOO LOW"], re)).not.toBeNull();
  });
});
