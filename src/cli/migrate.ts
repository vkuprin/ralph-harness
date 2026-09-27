import { type Config, KEYS, defaults, parseConfig } from "../lib/config.ts";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { TEMPLATE } from "../paths.ts";

// `ralph migrate`: a loop's config.sh, from the bash harness, as config.json.
//
// config.sh was *sourced*, so in principle it could hold any bash at all. The
// loops it was written for hold plain assignments — `KEY=value`, quoted the
// three ways bash quotes, several to a line, and `KEY=( … )` word lists — and
// that is what this reads. Anything else (a `$` expansion, a backtick, `$'…'`,
// `+=`, a command, a glob in a list) is refused with the line it is on,
// because guessing at what bash would have made of it is how a converted loop
// ends up with a setting nobody wrote. A human converts that line by hand.

type Value = string | string[];

class Refused extends Error {}

interface Assignment {
  key: string;
  value: Value;
  /** The value began with "$RATE_LIMIT_RE": it extends the default. */
  extends: boolean;
}

function lineOf(text: string, at: number): string {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const end = text.indexOf("\n", at);
  return text.slice(start, end < 0 ? undefined : end).trim();
}

/** Parse the assignments in `text`, in order. */
export function assignments(text: string): Assignment[] {
  const out: Assignment[] = [];
  let i = 0;
  const refuse = (why: string, at = i): never => {
    throw new Refused(`${why}, in: ${lineOf(text, at)}`);
  };
  const isBreak = (ch: string | undefined) => ch === undefined || ch === " " || ch === "\t" || ch === "\n" || ch === ";";

  /** One word from i: quoting applied. Stops at an unquoted break (or `)` in a list). */
  const word = (key: string, inList: boolean, first: boolean): { text: string; extends: boolean } => {
    let s = "";
    let ext = false;
    const start = i;
    while (i < text.length) {
      const ch = text[i]!;
      if (isBreak(ch) || (inList && ch === ")")) break;
      if (ch === "'") {
        const end = text.indexOf("'", i + 1);
        if (end < 0) refuse("a quote that never closes");
        s += text.slice(i + 1, end);
        i = end + 1;
      } else if (ch === '"') {
        i++;
        while (i < text.length && text[i] !== '"') {
          const c = text[i]!;
          if (c === "\\" && i + 1 < text.length && '$`"\\\n'.includes(text[i + 1]!)) {
            if (text[i + 1] !== "\n") s += text[i + 1];
            i += 2;
          } else if (c === "$") {
            const rest = text.slice(i);
            const m = /^\$(RATE_LIMIT_RE\b|\{RATE_LIMIT_RE\})/.exec(rest);
            if (m && key === "RATE_LIMIT_RE" && first && s === "" && i === start + 1) {
              ext = true;
              i += m[0].length;
            } else {
              refuse("a $ expansion, which this converter does not evaluate");
            }
          } else if (c === "`") {
            refuse("a command substitution");
          } else {
            s += c;
            i++;
          }
        }
        if (i >= text.length) refuse("a quote that never closes", start);
        i++;
      } else if (ch === "\\") {
        if (text[i + 1] === "\n") i += 2;
        else {
          s += text[i + 1] ?? "";
          i += 2;
        }
      } else if (ch === "$") {
        refuse(text[i + 1] === "'" ? "a $'…' string" : "a $ expansion, which this converter does not evaluate");
      } else if (ch === "`") {
        refuse("a command substitution");
      } else if ("|&<>()".includes(ch)) {
        refuse("shell syntax where a value belongs");
      } else if (inList && "*?[".includes(ch)) {
        refuse("a glob in a list, which bash would have expanded");
      } else if (ch === "~" && s === "" && i === start) {
        refuse("a ~ that bash would have expanded");
      } else {
        s += ch;
        i++;
      }
    }
    return { text: s, extends: ext };
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === ";") {
      i++;
      continue;
    }
    if (ch === "#") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)/.exec(text.slice(i));
    if (!m) refuse("not a setting (a command, or an export)");
    if (m![2] === "+=") refuse("a += that appends to a value this converter cannot see");
    const key = m![1]!;
    if (!(KEYS as string[]).includes(key)) refuse(`${key} is not a setting this harness knows`);
    i += m![0].length;
    if (text[i] === "(") {
      i++;
      const list: string[] = [];
      for (;;) {
        while (i < text.length && " \t\n".includes(text[i]!)) i++;
        if (text[i] === "#") {
          const end = text.indexOf("\n", i);
          i = end < 0 ? text.length : end;
          continue;
        }
        if (i >= text.length) refuse("a list that never closes");
        if (text[i] === ")") {
          i++;
          break;
        }
        list.push(word(key, true, false).text);
      }
      out.push({ key, value: list, extends: false });
    } else {
      const w = word(key, false, true);
      out.push({ key, value: w.text, extends: w.extends });
    }
  }
  return out;
}

function asJson(key: keyof Config, value: Value): unknown {
  // The kind of a setting is the kind of its default.
  const def = defaults("/")[key] as unknown;
  const scalar = Array.isArray(value) ? null : value;
  if (Array.isArray(def)) {
    // "${FROZEN[@]}" of a plain FROZEN=x is the one word.
    if (Array.isArray(value)) return value;
    return scalar === "" ? [] : [scalar];
  }
  if (scalar === null) throw new Refused(`${key} is a list here, and it is not a list setting`);
  if (key === "PUSH") {
    if (scalar === "pr") return "pr";
    if (scalar === "1") return true;
    if (scalar === "0" || scalar === "") return false;
    throw new Refused(`PUSH=${scalar} is not 0, 1 or pr`);
  }
  if (typeof def === "boolean") {
    if (scalar === "1") return true;
    if (scalar === "0" || scalar === "") return false;
    throw new Refused(`${key}=${scalar} is not 0 or 1`);
  }
  if (typeof def === "number") {
    if (/^-?\d+$/.test(scalar)) return Number(scalar);
    throw new Refused(`${key}=${scalar} is not a whole number`);
  }
  return scalar;
}

export type Migrated = { ok: true; json: string; config: Record<string, unknown> } | { ok: false; error: string };

export function migrate(text: string, name: string): Migrated {
  const settings: Record<string, unknown> = {};
  try {
    for (const a of assignments(text)) {
      if (a.extends) {
        // "$RATE_LIMIT_RE|x": the default, extended. JSON cannot refer to the
        // default, so the extension has a key of its own.
        const v = typeof a.value === "string" ? a.value : "";
        delete settings.RATE_LIMIT_RE;
        if (v.startsWith("|")) settings.RATE_LIMIT_EXTRA_RE = v.slice(1);
        else if (v !== "") throw new Refused(`RATE_LIMIT_RE="$RATE_LIMIT_RE${v}" does not extend the pattern with a |`);
        continue;
      }
      settings[a.key] = asJson(a.key as keyof Config, a.value);
    }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message };
    throw e;
  }
  const body = JSON.stringify({ $schema: pathToFileURL(join(TEMPLATE, "config.schema.json")).href, ...settings }, null, 2);
  const json =
    `// Settings for the ${name} loop, converted by "ralph migrate" from config.sh.old.\n` +
    "// Only what that file set is here; every other setting takes the harness default,\n" +
    "// which is what it did before. template/config.json in the harness documents them all.\n" +
    `${body}\n`;
  // What the loop will read back, judged by the loop's own reader.
  const check = parseConfig(json, "config.json", "/");
  if (!check.ok) return { ok: false, error: check.error };
  return { ok: true, json, config: settings };
}
