// PROMPT.md's `## Hard constraints`: what every result must pass, one numbered
// pass/fail test per item. Steering ranks; this filters. Only the human writes
// it, by hand between iterations or with `ralph steer --hard`, which can land
// while an iteration runs. The agent can write in the loop directory, so the
// loop puts the section back when an iteration changed it (`holdConstraints`):
// what the iteration started with, plus what `steer --hard` added meanwhile,
// which `ralph steer --hard` records in HARD_ADDED. That file only adds, so a
// write to it can make the list stricter and never looser.

import { chomp, splitLines } from "../lib/text.ts";

export const HARD = "## Hard constraints";
/** One JSON string per line: the text of each `ralph steer --hard` since the iteration began. */
export const HARD_ADDED = ".hard-added";
/** How a hard steer reads in STEER.md, for the iteration in flight. */
export const HARD_STEER = "Hard constraint (anything that fails it is out): ";

const flat = (t: string) => t.replace(/\s+/g, " ").trim();

/** Nothing set yet: blank, or the template's `<...>` placeholder. */
export function isPlaceholder(body: string): boolean {
  const joined = splitLines(body).join("");
  return !/\S/.test(joined) || /^\s*<.*>\s*$/.test(joined);
}

/** The body without the blank lines around it, and with nothing for a placeholder. */
function base(body: string): string {
  return isPlaceholder(body) ? "" : chomp(body.replace(/^\s*\n/, ""));
}

/** Each numbered item's text, number dropped, flattened: what two entries are compared by. */
function items(body: string): string[] {
  const out: string[] = [];
  for (const line of splitLines(body)) {
    const m = /^\d+\.\s+(.*)$/.exec(line);
    if (m) out.push(m[1]!);
    else if (out.length && /\S/.test(line)) out[out.length - 1] += ` ${line}`;
  }
  return out.map(flat);
}

/**
 * The body with `text` as one more item, numbered after the items already
 * there, its later lines indented under the first so none can be a heading. A
 * placeholder is replaced, not added to.
 */
export function appendEntry(body: string, text: string): string {
  const lines = splitLines(text.replace(/\r\n?/g, "\n"));
  while (lines.length && !/\S/.test(lines[0]!)) lines.shift();
  while (lines.length && !/\S/.test(lines.at(-1)!)) lines.pop();
  const kept = base(body);
  const n = items(kept).length + 1;
  const entry = lines.map((l, i) => (i === 0 ? `${n}. ${l.trim()}` : /\S/.test(l) ? `   ${l}` : "")).join("\n");
  return kept ? `${kept}\n${entry}` : entry;
}

/** What `ralph steer --hard` recorded in HARD_ADDED; a line that is not a JSON string is not an entry. */
export function readAdded(text: string): string[] {
  const out: string[] = [];
  for (const line of splitLines(text)) {
    try {
      const v: unknown = JSON.parse(line);
      if (typeof v === "string" && /\S/.test(v)) out.push(v);
    } catch {}
  }
  return out;
}

/** The section an iteration has to leave: `before`, plus each added entry it does not hold yet, in order. */
export function expectedHard(before: string, added: string[]): string {
  let body = base(before);
  for (const text of added) if (!items(body).includes(flat(text))) body = appendEntry(body, text);
  return body;
}

/** Two bodies of the section say the same, whatever the whitespace. */
export const sameHard = (a: string, b: string) => flat(a) === flat(b);
