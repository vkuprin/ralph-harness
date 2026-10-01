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

/**
 * The body of a `## Heading` section of a markdown file: the lines after the
 * first line starting with `heading`, up to the next line starting with `## `,
 * with trailing newlines stripped — what `awk '/^## X/{f=1; next} /^## /{f=0} f'`
 * inside `$(…)` gave.
 */
export function section(text: string, heading: string): string {
  const out: string[] = [];
  let on = false;
  for (const line of splitLines(text)) {
    if (line.startsWith(heading)) {
      on = true;
      continue;
    }
    if (line.startsWith("## ")) on = false;
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
