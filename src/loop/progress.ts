import { inFence, isHeading, splitLines } from "../lib/text.ts";

// PROGRESS.md is the loop's memory: the agent rewrites it at the end of every
// iteration and every prompt carries it. Two bounds keep it from ending the
// loop, and they are different in kind.

export interface Capped {
  /** How many '### ' entries the Log section held. */
  entries: number;
  /** PROGRESS.md with the entries past `keep` taken out, or null when nothing moves. */
  kept: string | null;
  /** The entries that moved, oldest first, as they go into the archive. */
  archived: string;
}

/**
 * The entry cap: keep the head sections plus the newest `keep` '### ' entries
 * under '## Log'. The agent writes that shape, so this can be switched off by
 * accident; injectProgress is the bound that cannot.
 */
export function capProgress(text: string, keep: number): Capped {
  const lines = splitLines(text);
  // A heading in a fenced code block is quoted text. Read as one, a `## ` in an
  // entry's shell snippet ended the Log there: the cap archived half the entry
  // and every entry below it stayed in PROGRESS.md for good.
  const code = inFence(lines);
  const kept: string[] = [];
  // The overflow, one group per entry, newest first.
  const groups: string[][] = [];
  let inLog = false;
  let c = 0;
  for (const [i, line] of lines.entries()) {
    if (!code[i] && isHeading(line, "## Log")) {
      inLog = true;
      kept.push(line);
      continue;
    }
    if (inLog && !code[i] && line.startsWith("## ")) inLog = false;
    if (inLog && !code[i] && line.startsWith("### ") && ++c > keep) groups.push([]);
    if (inLog && c > keep) groups.at(-1)!.push(line);
    else kept.push(line);
  }
  if (c <= keep) return { entries: c, kept: null, archived: "" };
  // The archive reads oldest first.
  const archived = groups
    .reverse()
    .map((g) => g.map((l) => `${l}\n`).join(""))
    .join("");
  return { entries: c, kept: kept.map((l) => `${l}\n`).join(""), archived };
}

export const ARCHIVE_HEADER = "# Progress archive\n\nLog entries moved out of PROGRESS.md, oldest first.\n\n";

/**
 * The bound on the prompt, which no shape the agent invents can switch off:
 * inject at most `max` bytes, whole lines from the top, and say where the rest
 * is. The file itself is never touched. Bytes, not characters, or a file full
 * of em dashes would be let through at up to three bytes each.
 */
export function injectProgress(text: string, max: number, path: string): { text: string; cut: number | null } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (!(max > 0) || bytes <= max) return { text, cut: null };
  let n = 0;
  let out = "";
  for (const line of splitLines(text)) {
    n += Buffer.byteLength(line, "utf8") + 1;
    if (n > max) break;
    out += `${line}\n`;
  }
  out += `\n[Cut off here by the harness: PROGRESS.md is ${bytes} bytes and at most ${max} are injected. The whole file is on disk at ${path} — read it if you need what is missing from the end. Then shorten it, because a prompt that keeps growing is what ends a loop.]\n`;
  return { text: out, cut: bytes };
}

const ITEM = /^ ?(?:[-*+]|\d+[.)])\s/;
const SUBHEADING = /^#{3,}\s/;
const PLACEHOLDER = /^(?:nothing|none)(?: (?:yet|open|pending|so far|for now|right now|at the moment))?[.!]?$/;
const TEMPLATE_INTRO = "things only the human can settle";

/**
 * The "Needs a decision" section, one entry per item: how the agent hands a
 * blocker back. An item is a list item, a `###` heading or a paragraph, with
 * every line that continues it — indented lines, sub-bullets, a fenced block,
 * a hard-wrapped line — because an agent rewrites PROGRESS.md whole and
 * re-wraps its bullets as it goes. Read line by line, every re-wrap was a new
 * question, and a loop notified on eight iterations of eight. The template's
 * own sentence and its placeholders ("_(nothing yet)_", "(none open)") are not
 * questions.
 */
export function decisions(text: string): string[] {
  const items: string[][] = [];
  const lines = splitLines(text);
  const code = inFence(lines);
  let on = false;
  let cur: string[] | null = null;
  let underHeading = false;
  let blank = true;
  for (const [i, line] of lines.entries()) {
    if (!code[i] && isHeading(line, "## Needs a decision")) {
      [on, cur, blank] = [true, null, true];
      continue;
    }
    if (!on) continue;
    if (!code[i] && line.startsWith("## ")) {
      on = false;
      continue;
    }
    if (!/\S/.test(line)) {
      cur?.push(line);
      blank = true;
      continue;
    }
    const item = !code[i] && ITEM.test(line);
    const heading = !code[i] && SUBHEADING.test(line);
    const paragraph = !code[i] && !/^\s/.test(line) && blank && !underHeading;
    if (!cur || item || heading || paragraph) {
      cur = [line];
      items.push(cur);
      underHeading = heading;
    } else {
      cur.push(line);
    }
    blank = false;
  }
  return items
    .map((l) => l.join("\n").trimEnd())
    .filter((t) => {
      const plain = flatten(t).replace(/[()[\]]/g, "");
      return plain !== "" && !PLACEHOLDER.test(plain) && !plain.startsWith(TEMPLATE_INTRO);
    });
}

/** An item's text on one line: no list marker, no emphasis, no wrapping, lower case. */
function flatten(item: string): string {
  return item
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{3,})\s+/, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * What makes a question the same question from one iteration to the next: the
 * first sentence of its opening paragraph (a heading's own line), flattened.
 * Re-wrapping it, or adding a sub-bullet or a paragraph under it, leaves the
 * key alone; a new question, or a question rewritten, does not.
 */
export function decisionKey(item: string): string {
  const lines = splitLines(item);
  const head = [lines[0]!];
  if (!SUBHEADING.test(lines[0]!)) {
    for (const line of lines.slice(1)) {
      if (!/\S/.test(line) || /^\s+(?:[-*+]|\d+[.)])\s/.test(line)) break;
      head.push(line);
    }
  }
  const flat = flatten(head.join("\n"));
  const first = /^.*?[.?!](?=\s|$)/.exec(flat);
  return (first ? first[0] : flat).slice(0, 160);
}
