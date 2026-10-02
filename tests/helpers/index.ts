import { afterAll, beforeAll } from "bun:test";
import {
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
import { basename, delimiter, dirname, join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");
export const IS_WIN = process.platform === "win32";

/**
 * Where the claude and gh stand-ins are. On Windows a script cannot be started
 * as a program, and the harness finds claude.exe on PATH and nothing else, so
 * the preload compiles each stub into an .exe once per run.
 */
export function stubDir(): string {
  return (globalThis as { ralphStubBin?: string }).ralphStubBin ?? join(ROOT, "tests/stub");
}

// ---------------------------------------------------------------- the harness

export function loopArgv(dir?: string): string[] {
  return [process.execPath, join(ROOT, "src/loop/main.ts"), ...(dir === undefined ? [] : [dir])];
}
export function cliPath(): string {
  return join(ROOT, "bin/ralph");
}
/** A PreToolUse hook's answer, in either shape claude reads. */
export interface HookAnswer {
  decision?: string;
  reason?: string;
  hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string };
}
export function hookArgv(): string[] {
  return [process.execPath, join(ROOT, "hooks/steer.ts")];
}
/** beforeAll with room for a whole loop run: hooks do not get the default test timeout. */
export function setup(fn: () => unknown): void {
  beforeAll(fn, 600_000);
}

export const TEMPLATE_CONFIG = join(ROOT, "template/config.json");

export type Val = string | number | boolean | string[];
export type Config = Record<string, Val>;

/** A word single-quoted for sh. */
export const sq = (s: string) => `'${s.split("'").join(`'\\''`)}'`;

/** Write a loop's whole config.json. */
export function writeConfig(dir: string, cfg: Config): void {
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`);
}
/** Add or override settings in a loop's config.json. */
export function patchConfig(dir: string, cfg: Config): void {
  const file = join(dir, "config.json");
  const now = Bun.JSONC.parse(readFileSync(file, "utf8")) as Config;
  writeFileSync(file, `${JSON.stringify({ ...now, ...cfg }, null, 2)}\n`);
}
/** What the harness reads back for `key` — the value, not the bytes. */
export function readConfigValue(file: string, key: string): string | undefined {
  try {
    const v = (Bun.JSONC.parse(readFileSync(file, "utf8")) as Config)[key];
    return v === undefined ? undefined : String(v);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- the fixture
const KEEP = process.env.KEEP_T === "1";

/**
 * The PATH with every directory that holds a claude of its own taken out, on
 * Windows. There a program is found by more than PATH order (the directory of
 * the program starting it, the working directory, the extensions in PATHEXT),
 * and the real claude.exe, reached once, ran a paid session under
 * --dangerously-skip-permissions in a fixture. The stub has to be the only one.
 */
let pathNoClaude: string | null = null;
function noClaude(): string {
  if (pathNoClaude !== null) return pathNoClaude;
  if (!existsSync(join(stubDir(), "claude.exe"))) throw new Error(`the claude stub was not compiled into ${stubDir()}`);
  const exts = ["", ".exe", ".cmd", ".bat", ".ps1", ".com"];
  pathNoClaude = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((d) => d !== "" && !exts.some((e) => existsSync(join(d, `claude${e}`))))
    .join(delimiter);
  return pathNoClaude;
}

const WIN_ENV = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "APPDATA",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
];

export interface Ran {
  code: number;
  out: string;
  err: string;
}

/**
 * Seconds one `Fx.sh` command may run. The longest the suite makes on purpose
 * took 15s on macOS (`ralph stop` waiting out a loop that ignores TERM), and
 * `ralph start` can wait 3 × 30s for a loop that hangs at boot. A command that
 * hangs now costs its test five minutes, instead of the whole job.
 */
const SH_TIMEOUT = 300;

/**
 * A loop the suite started. `proc` is the process running now, and the boot
 * watch in `startLoop` may replace it, so a `proc` read earlier can be one that
 * is gone: a TERM sent to it once missed the replacement, whose agent then held
 * `done` past the hook's 600s. A run is stopped through `kill` or `term`, which
 * reach the process running when they are called and start none after it.
 */
export interface LoopRun {
  readonly proc: Bun.Subprocess;
  done: Promise<number>;
  /** Set by `kill` and `term`: no process is started after the one running now. */
  stopped: boolean;
  /** `signal` to the process running now, and no restart after it. */
  kill(signal?: NodeJS.Signals): void;
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

  constructor(label: string) {
    const base = process.env.TMPDIR ?? tmpdir();
    this.T = realpathSync(mkdtempSync(join(base, `ralph-test-${label}.`)));
    mkdirSync(join(this.T, ".home"));
    writeFileSync(
      join(this.T, ".gitconfig"),
      "[user]\n\tname = ralph test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
    );
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
      PATH: `${stubDir()}${delimiter}${IS_WIN ? noClaude() : (process.env.PATH ?? "/usr/bin:/bin")}`,
      HOME: join(this.T, ".home"),
      GIT_CONFIG_GLOBAL: join(this.T, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "ralph test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "ralph test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    };
    if (IS_WIN) {
      // What Windows itself needs to start a program, and the fake home as the
      // Windows home too: homedir() reads USERPROFILE there, not HOME.
      out.USERPROFILE = out.HOME!;
      for (const k of WIN_ENV) {
        const v = process.env[k];
        if (v !== undefined) out[k] = v;
      }
    } else {
      out.TMPDIR = process.env.TMPDIR ?? "/tmp";
    }
    for (const k of ["LANG", "LC_ALL", "TZ"]) {
      const v = process.env[k];
      if (v !== undefined) out[k] = v;
    }
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
    return out;
  }

  /**
   * Run a command to completion, or throw once it has run `timeout` seconds
   * (SH_TIMEOUT). A synchronous spawn blocks the event loop, so bun's own test
   * timeout cannot end one that never returns, and on Windows one `fx.cli`
   * call held its job until the 45-minute cap cancelled it.
   */
  sh(argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; input?: string; timeout?: number } = {}): Ran {
    // Windows starts no script by its #! line; bun runs the CLI there.
    if (IS_WIN && argv[0] === cliPath()) argv = [process.execPath, ...argv];
    const secs = opts.timeout ?? SH_TIMEOUT;
    const r = Bun.spawnSync(argv, {
      cwd: opts.cwd,
      env: this.env(opts.env),
      stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
      stdout: "pipe",
      stderr: "pipe",
      timeout: secs * 1000,
      // TERM is the default, and a command that ignores it ran on to its end.
      killSignal: "SIGKILL",
    });
    const out = r.stdout.toString();
    const err = r.stderr.toString();
    if (r.exitedDueToTimeout) {
      throw new Error(`${argv.join(" ")} did not return within ${secs}s and was killed\nstdout: ${out}\nstderr: ${err}`);
    }
    return { code: r.exitCode ?? 128, out, err };
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

  /**
   * Start the loop on `dir`, output to `dir/ralph.out`. Bun on Linux now and
   * then never finishes loading the loop (see cmdStart), and a test waiting on
   * it waited out the whole hook timeout; so, as `ralph start` does, a loop
   * that has not taken its lock or exited within `bootWait` seconds (30) is
   * killed and started again, twice at most, unless the run was stopped.
   */
  startLoop(
    dir: string,
    stub: string,
    opts: { remote?: string; env?: Record<string, string | undefined>; bootWait?: number } = {},
  ): LoopRun {
    const spawnOnce = (flags: string) => {
      const out = openSync(join(dir, "ralph.out"), flags);
      const proc = Bun.spawn(loopArgv(dir), {
        env: this.env({ STUB_DIR: stub, STUB_REMOTE: opts.remote ?? "", ...opts.env }),
        stdin: "ignore",
        stdout: out,
        stderr: out,
      });
      closeSync(out);
      return proc;
    };
    let current = spawnOnce("w");
    const run: LoopRun = {
      get proc() {
        return current;
      },
      done: Promise.resolve(0),
      stopped: false,
      kill(signal = "SIGTERM") {
        run.stopped = true;
        current.kill(signal);
      },
    };
    run.done = (async () => {
      for (let attempt = 1; ; attempt++) {
        const proc = current;
        let exited = false;
        void proc.exited.then(() => {
          exited = true;
        });
        const booted = () => exited || read(join(dir, "ralph.lock")).trim() === String(proc.pid);
        if ((await until(booted, opts.bootWait ?? 30)) || attempt >= 3) return proc.exited;
        proc.kill("SIGKILL");
        const code = await proc.exited;
        // A stop that came while this one hung, or while it was being killed:
        // on Windows the stop file is never read by a loop that hangs, and its
        // replacement would delete it and run on.
        if (run.stopped) return code;
        console.warn(
          `loop ${dir} (PID ${proc.pid}) had not started after ${opts.bootWait ?? 30}s; bun never finished loading it — starting it again`,
        );
        current = spawnOnce("a");
      }
    })();
    return run;
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

// Windows has no ps that sees native processes (Git's is MSYS's own), so the
// command lines come from CIM there, with the PID in the environment.
function cim(filter: string): string {
  const script = `Get-CimInstance Win32_Process ${filter} | ForEach-Object { $_.CommandLine }`;
  const r = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "ignore",
  });
  return r.stdout.toString();
}

function commandOf(pid: number): string {
  if (IS_WIN) return cim(`-Filter "ProcessId=${Math.trunc(pid)}"`);
  const r = Bun.spawnSync(["ps", "-ww", "-p", String(pid), "-o", "command="]);
  return r.exitCode === 0 ? r.stdout.toString() : "";
}

/** Nothing on the machine runs out of this run's own path. Snapshot first, then a literal match. */
export function noProc(text: string): boolean {
  const snap = IS_WIN ? cim("") : Bun.spawnSync(["ps", "-axww", "-o", "command="]).stdout.toString();
  return !snap.includes(text);
}

/**
 * The sleeper this run started died with its process group. The stub records
 * the PID of the `sleep` it leaves behind, so this asks about that one process.
 * An empty file is a failure: the stub never got as far as sleeping.
 *
 * A sleep killed a moment ago is still listed until it is reaped (macOS shows
 * the zombie as "(sleep)"), so one look races the kill. It gets up to 2s to go,
 * a deadline rather than a count because one look through CIM is slow.
 */
export function sleeperGone(pidFile: string): boolean {
  const pid = Number(read(pidFile).trim());
  if (!pid) return false;
  const deadline = Date.now() + 2000;
  for (;;) {
    if (!commandOf(pid).includes("sleep")) return true;
    if (Date.now() >= deadline) return false;
    Bun.sleepSync(100);
  }
}

/** Wait until ps shows `pid` running something holding `text`. */
export async function waitProc(pid: number, text: string): Promise<boolean> {
  for (let i = 0; i < 25; i++) {
    if (commandOf(pid).includes(text)) return true;
    await Bun.sleep(100);
  }
  return false;
}

/**
 * What `ralph stop` sends a loop: TERM, or on Windows, which has no TERM a
 * program can catch, the stop file the loop watches for. `run` is stopped
 * whatever happens, so its boot watch starts nothing after this. `pid` when
 * the loop is not the run's process (one `ralph start` put in the background).
 */
export function term(dir: string, run: LoopRun | null, pid?: number): void {
  if (run) run.stopped = true;
  if (IS_WIN) {
    writeFileSync(join(dir, "ralph.stop"), "");
    return;
  }
  try {
    if (pid) process.kill(pid, "SIGTERM");
    else run?.kill("SIGTERM");
  } catch {}
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

export const strangers = () => (globalThis as { ralphStrangers?: { sleep: number; soak: number; dir: string } }).ralphStrangers!;

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
