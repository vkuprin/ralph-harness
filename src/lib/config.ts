import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// A loop's settings: config.json in the loop directory, read once at start — a
// restart is how a setting changes. JSON with comments and trailing commas
// allowed, so the template can carry its documentation beside each setting.
//
// A setting the harness could not read is not a default. A file that does not
// parse, a key the harness does not know, or a value of the wrong type refuses
// the start: running on with only the settings it understood is how a loop
// written for a gated worktree once committed into the user's own checkout.

export type Push = false | true | "pr";

export interface Config {
  REPO: string;
  MODEL: string;
  MAX_ITER: number;
  QUIET_STOP: number;
  QUIET_SLEEP: number;
  STEP_SLEEP: number;
  ADD_DIRS: string[];
  CLOSING: string;
  WORKTREE: boolean;
  WORKTREE_DIR: string;
  BRANCH: string;
  PUSH: Push;
  SETUP_CMD: string;
  ITER_TIMEOUT: number;
  VERIFY_CMD: string;
  VERIFY_TIMEOUT: number;
  FROZEN: string[];
  REVIEW: boolean;
  REVIEW_LIMIT_TRIES: number;
  DONE_CMD: string;
  ACTIVE_HOURS: string;
  ACTIVE_POLL: number;
  DENY: string[];
  REVIEW_MODEL: string;
  HEALTH_CMD: string;
  HEALTH_TIMEOUT: number;
  CHURN_AT: number;
  CHURN_WINDOW: number;
  CHURN_IGNORE: string[];
  RATE_LIMIT_SLEEP: number;
  LIMIT_RESET: boolean;
  ERROR_SLEEP: number;
  ERROR_STOP: number;
  PROGRESS_KEEP: number;
  PROGRESS_MAX_BYTES: number;
  ESCALATE_AFTER: number;
  NOTIFY_CMD: string;
  NOTIFY_TIMEOUT: number;
  LIVE_STEER: boolean;
  LOG_MAX_BYTES: number;
  LOG_KEEP: number;
  REF_KEEP: number;
  POLL_GAP_MAX: number;
  RATE_LIMIT_RE: string;
  RATE_LIMIT_EXTRA_RE: string;
}

// What claude prints when a limit ends a run: plan limits (5-hour, weekly), an
// overloaded API, or an API key out of credit. Only consulted when claude
// exited non-zero, and only on its last lines, so an audit whose own output
// mentions "429" is never misread. A limit is waited out, never a failure.
export const DEFAULT_RATE_LIMIT_RE =
  "hit your ([a-z]+ )?limit|usage limit|(weekly|session|[0-9]+-hour) limit|rate_limit_error|overloaded_error|API Error: (429|529)|credit balance is too low|spend limit|insufficient_quota";

/**
 * Every default keeps a loop written for the old harness behaving as it did:
 * no worktree, no push, no reviewer. These are the harness's defaults and not
 * the template's — a key a config leaves out gets these, so a loop that never
 * set WORKTREE does not quietly gain a worktree, a push and a reviewer.
 */
export function defaults(dir: string): Config {
  return {
    REPO: "",
    MODEL: "opus",
    MAX_ITER: 500,
    QUIET_STOP: 0,
    QUIET_SLEEP: 1200,
    STEP_SLEEP: 30,
    ADD_DIRS: [],
    CLOSING: `Run one iteration now. When you are done, rewrite ${join(dir, "PROGRESS.md")} with your entry at the top of the Log section.`,
    WORKTREE: false,
    WORKTREE_DIR: "",
    BRANCH: "main",
    PUSH: false,
    SETUP_CMD: "",
    ITER_TIMEOUT: 7200,
    VERIFY_CMD: "",
    VERIFY_TIMEOUT: 1800,
    FROZEN: [],
    REVIEW: false,
    REVIEW_LIMIT_TRIES: 12,
    DONE_CMD: "",
    ACTIVE_HOURS: "",
    ACTIVE_POLL: 300,
    DENY: [],
    REVIEW_MODEL: "",
    HEALTH_CMD: "",
    HEALTH_TIMEOUT: 300,
    CHURN_AT: 0,
    CHURN_WINDOW: 8,
    CHURN_IGNORE: [],
    RATE_LIMIT_SLEEP: 1800,
    LIMIT_RESET: false,
    ERROR_SLEEP: 300,
    ERROR_STOP: 0,
    PROGRESS_KEEP: 8,
    PROGRESS_MAX_BYTES: 120000,
    ESCALATE_AFTER: 3,
    NOTIFY_CMD: "",
    NOTIFY_TIMEOUT: 30,
    LIVE_STEER: true,
    LOG_MAX_BYTES: 10000000,
    LOG_KEEP: 3,
    REF_KEEP: 20,
    POLL_GAP_MAX: 60,
    RATE_LIMIT_RE: DEFAULT_RATE_LIMIT_RE,
    RATE_LIMIT_EXTRA_RE: "",
  };
}

type Kind = "string" | "int" | "bool" | "strings" | "push" | "path" | "regex";

const KINDS: Record<keyof Config, Kind> = {
  REPO: "path",
  MODEL: "string",
  MAX_ITER: "int",
  QUIET_STOP: "int",
  QUIET_SLEEP: "int",
  STEP_SLEEP: "int",
  ADD_DIRS: "strings",
  CLOSING: "string",
  WORKTREE: "bool",
  WORKTREE_DIR: "path",
  BRANCH: "string",
  PUSH: "push",
  SETUP_CMD: "string",
  ITER_TIMEOUT: "int",
  VERIFY_CMD: "string",
  VERIFY_TIMEOUT: "int",
  FROZEN: "strings",
  REVIEW: "bool",
  REVIEW_LIMIT_TRIES: "int",
  DONE_CMD: "string",
  ACTIVE_HOURS: "string",
  ACTIVE_POLL: "int",
  DENY: "strings",
  REVIEW_MODEL: "string",
  HEALTH_CMD: "string",
  HEALTH_TIMEOUT: "int",
  CHURN_AT: "int",
  CHURN_WINDOW: "int",
  CHURN_IGNORE: "strings",
  RATE_LIMIT_SLEEP: "int",
  LIMIT_RESET: "bool",
  ERROR_SLEEP: "int",
  ERROR_STOP: "int",
  PROGRESS_KEEP: "int",
  PROGRESS_MAX_BYTES: "int",
  ESCALATE_AFTER: "int",
  NOTIFY_CMD: "string",
  NOTIFY_TIMEOUT: "int",
  LIVE_STEER: "bool",
  LOG_MAX_BYTES: "int",
  LOG_KEEP: "int",
  REF_KEEP: "int",
  POLL_GAP_MAX: "int",
  RATE_LIMIT_RE: "regex",
  RATE_LIMIT_EXTRA_RE: "regex",
};

export const KEYS = Object.keys(KINDS) as (keyof Config)[];

const WHAT: Record<Kind, string> = {
  string: "a string",
  path: "an absolute path",
  int: "a whole number",
  bool: "true or false",
  strings: "a list of strings",
  push: 'false, true or "pr"',
  regex: "a regular expression",
};

function coerce(kind: Kind, v: unknown): { ok: true; value: unknown } | { ok: false } {
  switch (kind) {
    case "string":
      return typeof v === "string" ? { ok: true, value: v } : { ok: false };
    case "path":
      // Empty is "not set"; anything else must not depend on where the loop
      // was started from.
      return typeof v === "string" && (v === "" || isAbsolute(v)) ? { ok: true, value: v } : { ok: false };
    case "int":
      return typeof v === "number" && Number.isInteger(v) ? { ok: true, value: v } : { ok: false };
    case "bool":
      if (typeof v === "boolean") return { ok: true, value: v };
      if (v === 0 || v === 1) return { ok: true, value: v === 1 };
      return { ok: false };
    case "strings":
      return Array.isArray(v) && v.every((x) => typeof x === "string") ? { ok: true, value: v } : { ok: false };
    case "push":
      if (v === "pr") return { ok: true, value: "pr" };
      if (typeof v === "boolean") return { ok: true, value: v };
      if (v === 0 || v === 1) return { ok: true, value: v === 1 };
      return { ok: false };
    case "regex":
      if (typeof v !== "string") return { ok: false };
      try {
        new RegExp(v, "i");
        return { ok: true, value: v };
      } catch {
        return { ok: false };
      }
  }
}

export type Loaded = { ok: true; config: Config } | { ok: false; error: string };

/** Parse `text` (the contents of `file`) into a config for the loop in `dir`. */
export function parseConfig(text: string, file: string, dir: string): Loaded {
  let raw: unknown;
  try {
    raw = Bun.JSONC.parse(text);
  } catch (e) {
    return { ok: false, error: `ralph: ${file} does not parse: ${(e as Error).message} — refusing to start with a config the harness could not read` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `ralph: ${file} does not parse: it must hold one object of settings` };
  }
  const config = defaults(dir) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "$schema") continue;
    const kind = KINDS[key as keyof Config];
    if (!kind) {
      return { ok: false, error: `ralph: ${file}: ${key} is not a setting this harness knows — refusing to start rather than ignore it` };
    }
    const c = coerce(kind, value);
    if (!c.ok) {
      return { ok: false, error: `ralph: ${file}: ${key} must be ${WHAT[kind]}, not ${JSON.stringify(value)}` };
    }
    config[key] = c.value;
  }
  return { ok: true, config: config as unknown as Config };
}

export function loadConfig(file: string, dir: string): Loaded {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, error: `ralph: cannot read ${file}: ${(e as Error).message}` };
  }
  return parseConfig(text, file, dir);
}

/** The limit pattern the loop reads: the default or its replacement, plus any extension. */
export function limitPattern(c: Config): RegExp {
  const base = c.RATE_LIMIT_RE;
  return new RegExp(c.RATE_LIMIT_EXTRA_RE ? `${base}|${c.RATE_LIMIT_EXTRA_RE}` : base, "i");
}

/** PUSH as the bash harness wrote it, for log lines people already grep. */
export function pushWord(p: Push): string {
  return p === "pr" ? "pr" : p ? "1" : "0";
}
