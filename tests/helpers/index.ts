import { afterAll, beforeAll, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");

// ---------------------------------------------------------------- which harness
// The suite is written once and run against either implementation: the bash
// one it was ported from (the oracle) and the TypeScript one replacing it.
// Everything that differs between the two — the command that starts a loop,
// the file a config lives in, how time is faked — is in this block and
// nowhere else, so the switch can be deleted whole at cutover.
export const IMPL: "bash" | "ts" = process.env.RALPH_IMPL === "ts" ? "ts" : "bash";
const RALPH_BASH = process.env.RALPH_BASH ?? "bash";
export const bashOnly = test.if(IMPL === "bash");
export const tsOnly = test.if(IMPL === "ts");

export function loopArgv(dir?: string): string[] {
  const args = dir === undefined ? [] : [dir];
  return IMPL === "bash" ? [RALPH_BASH, join(ROOT, "ralph.sh"), ...args] : [process.execPath, join(ROOT, "src/loop/main.ts"), ...args];
}
export function cliPath(): string {
  return IMPL === "bash" ? join(ROOT, "ralph") : join(ROOT, "bin/ralph");
}
export function hookArgv(): string[] {
  return IMPL === "bash" ? [join(ROOT, "hooks/steer.sh")] : [process.execPath, join(ROOT, "hooks/steer.ts")];
}
/** beforeAll with room for a whole loop run: hooks do not get the default test timeout. */
export function setup(fn: () => unknown): void {
  beforeAll(fn as () => Promise<void>, 600_000);
}

export const CONFIG = IMPL === "bash" ? "config.sh" : "config.json";
export const templateConfig = () => join(ROOT, "template", CONFIG);

export type Val = string | number | boolean | string[];
export type Config = Record<string, Val>;

/** A word single-quoted for sh. */
export const sq = (s: string) => `'${s.split("'").join(`'\\''`)}'`;
function bashVal(v: Val): string {
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `(${v.map(sq).join(" ")})`;
  return sq(v);
}
function bashLines(cfg: Config): string {
  return Object.entries(cfg)
    .map(([k, v]) =>
      // JSON cannot say "the default, and this": the TS config has a key for
      // it, and in bash it is the old `"$RATE_LIMIT_RE|…"`.
      k === "RATE_LIMIT_EXTRA_RE" ? `RATE_LIMIT_RE="$RATE_LIMIT_RE"${sq(`|${v}`)}\n` : `${k}=${bashVal(v)}\n`,
    )
    .join("");
}

/** Write a loop's whole config, in the form its harness reads. */
export function writeConfig(dir: string, cfg: Config): void {
  if (IMPL === "bash") writeFileSync(join(dir, "config.sh"), bashLines(cfg));
  else writeFileSync(join(dir, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`);
}
/** Add or override settings in a loop's config. */
export function patchConfig(dir: string, cfg: Config): void {
  if (IMPL === "bash") {
    appendFileSync(join(dir, "config.sh"), bashLines(cfg));
    return;
  }
  const file = join(dir, "config.json");
  const now = Bun.JSONC.parse(readFileSync(file, "utf8")) as Config;
  writeFileSync(file, `${JSON.stringify({ ...now, ...cfg }, null, 2)}\n`);
}
/** A config file written by hand, for the broken and the odd. */
export function rawConfig(dir: string, text: { bash: string; ts: string }): void {
  writeFileSync(join(dir, CONFIG), IMPL === "bash" ? text.bash : text.ts);
}
/** What the harness reads back for `key` — the value, not the bytes. */
export function readConfigValue(file: string, key: string): string | undefined {
  if (IMPL === "bash") {
    const r = Bun.spawnSync(["bash", "-c", `${key}=; . "$1" >/dev/null 2>&1; printf '%s' "\${!2}"`, "_", file, key], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir() },
    });
    return r.stdout.toString();
  }
  try {
    const v = (Bun.JSONC.parse(readFileSync(file, "utf8")) as Config)[key];
    return v === undefined ? undefined : String(v);
  } catch {
    return undefined;
  }
}

// The fake clock. The TS harness reads RALPH_TEST_CLOCK and RALPH_TEST_HOUR
// itself; the bash one reads `date`, so it gets a `date` on PATH that reads the
// same two files. Written at runtime, into the run's own directory.
const DATE_SHIM = `#!/bin/sh
if [ "$1" = "+%s" ] && [ -n "\${RALPH_TEST_CLOCK:-}" ] && [ -f "$RALPH_TEST_CLOCK" ]; then
  echo $(( $(/bin/date +%s) + $(cat "$RALPH_TEST_CLOCK") ))
elif [ "$1" = "+%H" ] && [ -n "\${RALPH_TEST_HOUR:-}" ] && [ -f "$RALPH_TEST_HOUR" ]; then
  cat "$RALPH_TEST_HOUR"
else
  exec /bin/date "$@"
fi
`;

// ---------------------------------------------------------------- the fixture
const KEEP = process.env.KEEP_T === "1";

export interface Ran {
  code: number;
  out: string;
  err: string;
}

export interface LoopRun {
  proc: Bun.Subprocess;
  done: Promise<number>;
}

/**
 * One test file's world: a temporary directory, a HOME and a git config of its
 * own, and the stubs on PATH. Nothing a test starts inherits the real HOME, the
 * real git config or any RALPH_* variable, so a forgotten RALPH_HOME cannot
 * reach the loops on this machine and a global commit.gpgsign cannot fail a
 * commit. The directory goes when the file is done, unless KEEP_T=1.
 */
export class Fx {
  readonly T: string;
  private readonly shims: string;

  constructor(label: string) {
    const base = process.env.TMPDIR ?? tmpdir();
    this.T = realpathSync(mkdtempSync(join(base, `ralph-test-${label}.`)));
    mkdirSync(join(this.T, ".home"));
    writeFileSync(
      join(this.T, ".gitconfig"),
      "[user]\n\tname = ralph test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
    );
    this.shims = join(this.T, ".shims");
    mkdirSync(this.shims);
    writeFileSync(join(this.shims, "date"), DATE_SHIM);
    chmodSync(join(this.shims, "date"), 0o755);
    afterAll(() => {
      if (!KEEP) rmSync(this.T, { recursive: true, force: true });
      else console.log(`kept ${this.T}`);
    });
  }

  p(...parts: string[]): string {
    return join(this.T, ...parts);
  }

  /** The environment every process a test starts gets, plus `extra`. */
  env(extra: Record<string, string | undefined> = {}): Record<string, string> {
    const out: Record<string, string> = {
      PATH: `${join(ROOT, "tests/stub")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: join(this.T, ".home"),
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      GIT_CONFIG_GLOBAL: join(this.T, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "ralph test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "ralph test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    };
    for (const k of ["LANG", "LC_ALL", "TZ", "RALPH_BASH"]) {
      const v = process.env[k];
      if (v !== undefined) out[k] = v;
    }
    if (extra.RALPH_TEST_CLOCK || extra.RALPH_TEST_HOUR) out.PATH = `${this.shims}:${out.PATH}`;
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
    return out;
  }

  /** Run a command to completion. */
  sh(argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; input?: string } = {}): Ran {
    const r = Bun.spawnSync(argv, {
      cwd: opts.cwd,
      env: this.env(opts.env),
      stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode ?? 128, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  /** `bash -c script`, with the arguments after it as $1, $2, … */
  bash(script: string, ...args: string[]): Ran {
    return this.sh(["bash", "-c", script, "_", ...args]);
  }

  /** git, and its trimmed stdout. */
  git(cwd: string, ...args: string[]): string {
    return this.sh(["git", "-C", cwd, ...args]).out.trim();
  }
  gitOk(cwd: string, ...args: string[]): boolean {
    return this.sh(["git", "-C", cwd, ...args]).code === 0;
  }

  /**
   * A fixture belongs to one test. Two sharing a name is how a check goes red
   * because of something it is not testing, hundreds of lines from the edit
   * that caused it — it happened twice — so the second is refused loudly.
   */
  fresh(path: string): void {
    if (existsSync(path)) throw new Error(`fixture reused: ${path} — a fixture name belongs to one test`);
  }

  /** A checkout of a fresh bare remote, with one commit: measure.sh passes until BAD exists. */
  makeRepo(dir: string, remote: string): void {
    this.fresh(dir);
    this.fresh(remote);
    this.must(["git", "init", "-q", "--bare", "-b", "main", remote]);
    this.must(["git", "init", "-q", "-b", "main", dir]);
    writeFileSync(join(dir, "measure.sh"), "#!/bin/sh\ntest ! -f BAD\n");
    chmodSync(join(dir, "measure.sh"), 0o755);
    writeFileSync(join(dir, "work.txt"), "start\n");
    this.must(["git", "-C", dir, "add", "-A"]);
    this.must(["git", "-C", dir, "commit", "-qm", "initial"]);
    this.must(["git", "-C", dir, "remote", "add", "origin", remote]);
    this.must(["git", "-C", dir, "push", "-q", "-u", "origin", "main"]);
  }

  private must(argv: string[]): void {
    const r = this.sh(argv);
    if (r.code !== 0) throw new Error(`${argv.join(" ")} failed: ${r.err}`);
  }

  /** A loop directory from the template, with every sleep set to 0 and `cfg` on top. */
  makeLoop(dir: string, repo: string, cfg: Config = {}): void {
    this.fresh(dir);
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(ROOT, "template/PROMPT.md"), join(dir, "PROMPT.md"));
    copyFileSync(join(ROOT, "template/PROGRESS.md"), join(dir, "PROGRESS.md"));
    writeConfig(dir, { REPO: repo, QUIET_SLEEP: 0, STEP_SLEEP: 0, ERROR_SLEEP: 0, RATE_LIMIT_SLEEP: 0, ...cfg });
  }

  /** A directory the stub reads its queues from and records into. */
  stub(name: string, modes: string[] = [], verdicts: string[] = []): string {
    const d = this.p(name);
    this.fresh(d);
    mkdirSync(d, { recursive: true });
    if (modes.length) writeFileSync(join(d, "modes"), `${modes.join("\n")}\n`);
    if (verdicts.length) writeFileSync(join(d, "verdicts"), `${verdicts.join("\n")}\n`);
    return d;
  }

  /** Start the loop on `dir`, output to `dir/ralph.out`. */
  startLoop(dir: string, stub: string, opts: { remote?: string; env?: Record<string, string | undefined> } = {}): LoopRun {
    const out = openSync(join(dir, "ralph.out"), "w");
    const proc = Bun.spawn(loopArgv(dir), {
      env: this.env({ STUB_DIR: stub, STUB_REMOTE: opts.remote ?? "", ...opts.env }),
      stdin: "ignore",
      stdout: out,
      stderr: out,
    });
    closeSync(out);
    return { proc, done: proc.exited };
  }

  /** Run the loop on `dir` to the end; its exit status. */
  async runLoop(dir: string, stub: string, opts: { remote?: string; env?: Record<string, string | undefined> } = {}): Promise<number> {
    return this.startLoop(dir, stub, opts).done;
  }

  /** The CLI, with `home` as RALPH_HOME. */
  cli(home: string | undefined, args: string[], env: Record<string, string | undefined> = {}): Ran {
    return this.sh([cliPath(), ...args], { env: { RALPH_HOME: home, ...env } });
  }
}

// ---------------------------------------------------------------- reading results

export function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The verdict column of results.tsv, space separated. */
export function statuses(loop: string): string {
  return rows(loop)
    .map((r) => r[4])
    .join(" ");
}

/** results.tsv without its header, split into columns. */
export function rows(loop: string): string[][] {
  return read(join(loop, "results.tsv"))
    .split("\n")
    .slice(1)
    .filter((l) => l !== "")
    .map((l) => l.split("\t"));
}

export function count(text: string, re: RegExp): number {
  return text.split("\n").filter((l) => re.test(l)).length;
}

export function num(path: string): number {
  const t = read(path).trim();
  return t === "" ? 0 : Number(t);
}

export function lines(path: string): string[] {
  return read(path)
    .split("\n")
    .filter((l) => l !== "");
}

// ---------------------------------------------------------------- processes
// A check is about this run and nothing else. `pgrep -f <text>` reads the whole
// machine's process list, and its argument as a regex: a `sleep 999` a human
// typed in another terminal, or a second copy of this suite, used to turn these
// checks red. The suite is a loop's VERIFY_CMD, so a red check resets a commit
// that was fine.

function commandOf(pid: number): string {
  const r = Bun.spawnSync(["ps", "-ww", "-p", String(pid), "-o", "command="]);
  return r.exitCode === 0 ? r.stdout.toString() : "";
}

/** Nothing on the machine runs out of this run's own path. Snapshot first, then a literal match. */
export function noProc(text: string): boolean {
  const snap = Bun.spawnSync(["ps", "-axww", "-o", "command="]).stdout.toString();
  return !snap.includes(text);
}

/**
 * The sleeper this run started died with its process group. The stub records
 * the PID of the `sleep` it leaves behind, so this asks about that one process.
 * An empty file is a failure: the stub never got as far as sleeping.
 */
export function sleeperGone(pidFile: string): boolean {
  const pid = Number(read(pidFile).trim());
  if (!pid) return false;
  return !commandOf(pid).includes("sleep");
}

/** Wait until ps shows `pid` running something holding `text`. */
export async function waitProc(pid: number, text: string): Promise<boolean> {
  for (let i = 0; i < 25; i++) {
    if (commandOf(pid).includes(text)) return true;
    await Bun.sleep(100);
  }
  return false;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait up to `secs` for `cond`. */
export async function until(cond: () => boolean, secs: number): Promise<boolean> {
  for (let i = 0; i < secs * 10; i++) {
    if (cond()) return true;
    await Bun.sleep(100);
  }
  return cond();
}

export const strangers = () =>
  (globalThis as { ralphStrangers?: { sleep: number; soak: number; dir: string } }).ralphStrangers!;

export { basename, dirname, join };

// ---------------------------------------------------------------- notifiers

/**
 * A NOTIFY_CMD that records one line per event: event, loop, iteration, dir,
 * message, tab separated, with newlines and tabs in the message turned to
 * spaces. It reads its environment, which is how the harness passes the event.
 */
export function mkNotifier(log: string, script: string): void {
  writeFileSync(
    script,
    `#!/bin/sh
out=${sq(log)}
{ printf '%s\\t%s\\t%s\\t%s\\t' "$RALPH_EVENT" "$RALPH_LOOP" "$RALPH_ITER" "$RALPH_DIR"
  printf '%s' "$RALPH_MESSAGE" | tr '\\n\\t' '  '
  echo
} >> "$out"
`,
  );
  chmodSync(script, 0o755);
}

/** The events a notifier log holds, in order. */
export function events(log: string): string[] {
  return lines(log).map((l) => l.split("\t")[0]!);
}

/** Column `n` (1-based) of the first row for `event`. */
export function field(n: number, event: string, log: string): string {
  for (const l of lines(log)) {
    const f = l.split("\t");
    if (f[0] === event) return f[n - 1] ?? "";
  }
  return "";
}
