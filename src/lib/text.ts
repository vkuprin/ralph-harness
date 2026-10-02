// Small text helpers with the semantics of the shell tools they replace, so a
// port reads the same bytes the old code read.

/** The lines of a file's text; a trailing newline does not make an empty last line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** `tail -n n`. */
export function tailLines(text: string, n: number): string[] {
  const all = splitLines(text);
  return n >= all.length ? all : all.slice(all.length - n);
}

/** What `$(…)` keeps of a command's output: trailing newlines stripped. */
export function chomp(text: string): string {
  return text.replace(/\n+$/, "");
}

// CSI (colours, cursor moves), OSC (titles, links) and the short ESC sequences.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|[ -/]*[0-~])/g;

/**
 * A command's output without its terminal escape codes. A test runner colours
 * what it prints, and the codes are noise to every reader the harness hands
 * that output to: a prompt, a notification, a table.
 */
export function stripEscapes(text: string): string {
  return text.replace(ESCAPES, "");
}

/**
 * One line of a command's output as plain text: escape codes gone, and every
 * other control character (a tab, a carriage return) a space, so it can sit in
 * a column of results.tsv or a notification and read as what it says.
 */
export function plain(line: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return stripEscapes(line).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/**
 * The last line holding something other than whitespace, as plain text, or "".
 * Judged after the escapes are gone: a line that only resets the colour says
 * nothing, and the reason is the line before it.
 */
export function lastNonBlank(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = plain(lines[i]!);
    if (/\S/.test(line)) return line;
  }
  return "";
}

/** A fence line: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * For each line, whether it sits in a fenced code block, the fence lines
 * included. A `## ` there is text the agent quoted (a shell comment, a
 * markdown example), not a heading, and reading it as one cut a Log entry in
 * two. A fence that never closes is not counted as one: CommonMark runs it to
 * the end of the file, and one stray ``` would hide every heading after it.
 */
export function inFence(lines: string[]): boolean[] {
  const out = lines.map(() => false);
  // The shortest fence of each kind that found no closing line: no longer one
  // will either, so a file of unclosed fences is read once, not once per fence.
  const unclosed: Record<string, number> = { "`": Infinity, "~": Infinity };
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]!);
    // A backtick fence's info string holds no backtick: ```x``` is inline code.
    if (!open || (open[1]![0] === "`" && open[2]!.includes("`"))) continue;
    const [ch, len] = [open[1]![0]!, open[1]!.length];
    if (len >= unclosed[ch]!) continue;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = FENCE.exec(lines[j]!);
      if (close && close[1]![0] === ch && close[1]!.length >= len && !/\S/.test(close[2]!)) break;
    }
    if (j === lines.length) {
      unclosed[ch] = len;
      continue;
    }
    out.fill(true, i, j + 1);
    i = j;
  }
  return out;
}

/**
 * Whether `line` is the heading `name` (`## Log`): the name, then nothing or
 * anything that does not go on with the word, as in `## Log (newest first)`.
 * A heading that only starts with the name is another section. Read as the
 * Log, `## Login flow` had its `### ` notes counted as entries, so the cap
 * moved real ones to the archive under PROGRESS_KEEP, or moved the notes.
 */
export function isHeading(line: string, name: string): boolean {
  return line.startsWith(name) && !/^[\p{L}\p{N}_-]/u.test(line.slice(name.length));
}

/**
 * The body of a `## Heading` section of a markdown file: the lines after each
 * `heading` line (`isHeading`), up to the next line starting with `## `, with
 * trailing newlines stripped — what `awk '/^## X/{f=1; next} /^## /{f=0} f'`
 * inside `$(…)` gave, except that a line in a fenced code block is never a
 * heading, and `## The jobs table` is not `## The job`.
 */
export function section(text: string, heading: string): string {
  const out: string[] = [];
  let on = false;
  const lines = splitLines(text);
  const code = inFence(lines);
  for (const [i, line] of lines.entries()) {
    if (!code[i] && isHeading(line, heading)) {
      on = true;
      continue;
    }
    if (!code[i] && line.startsWith("## ")) on = false;
    if (on) out.push(line);
  }
  return chomp(out.length ? `${out.join("\n")}\n` : "");
}

/** At most `max` bytes of `text`, never splitting a character. */
export function headBytes(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  return buf.subarray(0, max).toString("utf8").replace(/�$/, "");
}

/** A JSON encoding with object keys sorted, as perl's JSON::PP canonical gave. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
