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

/** The last line holding something other than whitespace, or "". */
export function lastNonBlank(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) if (/\S/.test(lines[i]!)) return lines[i]!;
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
