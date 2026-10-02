import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { constants, devNull } from "node:os";
import { dlopen, FFIType } from "bun:ffi";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { LOOP_MARK } from "../paths.ts";
import { nowSec, sleep } from "./clock.ts";

// Everything the harness starts goes through this file, for two reasons.
//
// Every command that can run long (the agent, VERIFY_CMD, the reviewer, a push,
// a notifier) runs through runBounded in a process group of its own, so a
// timeout or `ralph stop` takes down everything it started — test runners, dev
// servers, MCP servers — and not only the top process.
//
// And a signal has to stop the loop where it stands. A handler in JS runs
// between awaits, not instead of them: after it kills the running child, the
// await that child was holding resolves and the iteration carries on towards
// its gates while the handler is still cleaning up. So once `freeze()` is
// called every primitive here stops returning, and the loop parks at its next
// await until the handler exits the process.

// Windows has neither process groups nor a TERM a console program can catch,
// so the same promises are kept there another way, and every difference is in
// this file: a job object, then a tree kill (taskkill /T), stands in for the group, output bound
// for a file is pumped through a pipe (see `pumped`), and a command line is
// read from CIM rather than ps.
export const IS_WIN = process.platform === "win32";
/** Where output nobody reads goes: /dev/null, or NUL on Windows. */
export const DEV_NULL = devNull;

let frozen = false;
const never = new Promise<never>(() => {});

export function freeze(): void {
  frozen = true;
}

async function settle<T>(value: T): Promise<T> {
  if (frozen) await never;
  return value;
}

/** Sleep that a signal ends at once (the handler exits while it waits). */
export async function nap(seconds: number): Promise<void> {
  if (!(seconds > 0)) return;
  await sleep(seconds * 1000);
  await settle(undefined);
}

/** The bounded command running now, if any: its group leader and its exit. */
export let current: { pid: number; done: Promise<number> } | null = null;
/** Plain children running now: git and the like, killed on a signal. */
export const plainChildren = new Set<ChildProcess>();

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const n = signal ? (constants.signals as Record<string, number>)[signal] : undefined;
  return 128 + (n ?? 0);
}

function exited(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    let done = false;
    child.once("exit", (code, signal) => {
      if (!done) {
        done = true;
        resolve(exitCode(code, signal));
      }
    });
    // A command that is not there never exits; it errors. 127 is what a shell
    // would have said, and what the gates' messages expect.
    child.once("error", () => {
      if (!done) {
        done = true;
        resolve(127);
      }
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// On Windows each bounded command goes into a job object of its own, and a
// kill ends the job. taskkill /T finds a tree by each process's parent PID, and
// Git Bash's fork and exec leave a process whose parent PID names one already
// gone. Measured on windows-2025: a hung git fetch's ssh transport, a `sh -c
// "sleep 611"` under core.sshCommand, outlived taskkill /T on git with and
// without an `exec` in front of it, and TerminateJobObject on a job git was put
// in when it started ended every process in it. A process started before the
// assignment is outside the job, so killTree still runs taskkill /T after it.
// A HANDLE is u64 and not ptr: Bun's FFI docs say a Windows HANDLE is not an
// address, and ptr does not carry one as expected.
const jobs = new Map<number, bigint>();
let kernel32: ReturnType<typeof openKernel32> | null | undefined;

function openKernel32() {
  return dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.u64 },
    AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.bool },
    TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.bool },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
  }).symbols;
}

function win32() {
  if (kernel32 === undefined) {
    try {
      kernel32 = openKernel32();
    } catch {
      kernel32 = null;
    }
  }
  return kernel32;
}

/** Put a command just started into a job of its own. Without one, killTree is taskkill /T alone. */
function enterJob(pid: number): void {
  const k = IS_WIN ? win32() : null;
  if (!k) return;
  const job = k.CreateJobObjectW(null, null);
  if (!job) return;
  // PROCESS_SET_QUOTA | PROCESS_TERMINATE, what AssignProcessToJobObject needs.
  const proc = k.OpenProcess(0x0101, false, pid);
  const ok = proc ? k.AssignProcessToJobObject(job, proc) : false;
  if (proc) k.CloseHandle(proc);
  if (ok) jobs.set(pid, job);
  else k.CloseHandle(job);
}

/** The command ended by itself: let go of its job, and leave what it left running alone. */
function leaveJob(pid: number): void {
  const job = jobs.get(pid);
  if (!job) return;
  jobs.delete(pid);
  win32()?.CloseHandle(job);
}

/**
 * TERM the whole group, give it up to ten seconds, then KILL the group. The
 * KILL goes out whether or not the leader has gone: a leader that exits on TERM
 * can leave children behind in its group that ignore it.
 */
export async function killGroup(pid: number, done?: Promise<number>): Promise<void> {
  if (IS_WIN) {
    // Nothing on Windows asks a process to stop that a console program started
    // without a console can answer, so the tree goes at once: the command and
    // everything it started.
    killTree(pid);
    if (done) await Promise.race([done, sleep(10_000)]);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (done) {
    await Promise.race([done, sleep(10_000)]);
  } else {
    for (let i = 0; i < 10 && alive(pid); i++) await sleep(1000);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

/**
 * KILL a process and everything it started, now: its group, or on Windows its
 * tree. For a process that never got as far as a handler (a loop bun never
 * finished loading) and for the last resort of `ralph stop`.
 */
export function killTree(pid: number): void {
  if (IS_WIN) {
    const job = jobs.get(pid);
    if (job) {
      win32()?.TerminateJobObject(job, 1);
      leaveJob(pid);
    }
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

/**
 * Whether output bound for a file is pumped through a pipe by this process
 * rather than handed to the child as a descriptor. On Windows it is: the bash
 * of Git for Windows (MSYS) drops every write to a handle opened for appending,
 * so VERIFY_CMD said nothing into verify.out and a failure had no reason.
 * Native programs (git, claude) write there fine, but bash is what every *_CMD
 * setting runs in.
 */
const pumped = IS_WIN;

/** Append whatever `stream` says to `file` as it arrives; resolves when it ends. */
function pumpTo(stream: Readable | null, file: string): Promise<void> {
  if (!stream) return Promise.resolve();
  appendFileSync(file, "");
  stream.on("data", (b: Buffer) => {
    try {
      appendFileSync(file, b);
    } catch {}
  });
  return new Promise((resolve) => {
    stream.once("close", () => resolve());
    stream.once("error", () => resolve());
  });
}

/**
 * Once the child has exited: what it wrote before it went, and no more. A
 * grandchild left running in the background (a dev server) can hold the pipe
 * open for ever, which a descriptor to a file never made anyone wait on.
 */
async function drained(child: ChildProcess, pumps: Promise<void>[]): Promise<void> {
  if (!pumps.length) return;
  await Promise.race([Promise.all(pumps), sleep(2000)]);
  child.stdout?.destroy();
  child.stderr?.destroy();
}

let bashFound: string | null = null;

/**
 * The bash that runs the *_CMD settings. On Windows it is Git for Windows' own:
 * `bash` on a Windows PATH is usually WSL's, which runs the command in another
 * machine with another filesystem. RALPH_BASH names one outright, then the one
 * Claude Code is told to use, then the one that came with git.
 */
export function bash(): string {
  if (!IS_WIN) return "bash";
  if (bashFound) return bashFound;
  const candidates = [process.env.RALPH_BASH, process.env.CLAUDE_CODE_GIT_BASH_PATH];
  const git = Bun.which("git");
  if (git) {
    // git.exe is in Git\cmd, Git\bin or Git\mingw64\bin; bash.exe in Git\bin.
    let d = dirname(realpathSync(git));
    for (let i = 0; i < 3; i++, d = dirname(d)) candidates.push(join(d, "bin", "bash.exe"));
  }
  candidates.push(join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"));
  bashFound = candidates.find((c) => c && existsSync(c)) ?? "bash";
  return bashFound;
}

export interface ShellRun {
  argv: string[];
  /** What goes into the command's environment on top of the rest. */
  env: Record<string, string>;
}

/**
 * A *_CMD setting as the harness runs it: the user's own text, to `bash -c`.
 *
 * On Windows the text goes in the environment and bash is handed a constant
 * that evals it. A program there gets one command line, not an argv, and an
 * MSYS bash started by a native program cuts that line up itself, treating `'`
 * as a quote and expanding globs: `'C:\tools\check.sh'`, with no space for the
 * quoting to protect it, reached bash as C:\tools\check.sh and ran as
 * C:toolscheck.sh. The environment is passed as it is, so the text arrives as
 * written, which is the rule for user text anyway.
 */
export function shellCommand(command: string): ShellRun {
  if (!IS_WIN) return { argv: ["bash", "-c", command], env: {} };
  return { argv: [bash(), "-c", 'eval "$RALPH_SHELL_CMD"'], env: { RALPH_SHELL_CMD: command } };
}

/**
 * On Windows the agent is started as `claude` with no shell, which finds
 * claude.exe (the native build) and never the claude.cmd an npm install puts
 * on PATH: that is a batch file, and starting it means cmd.exe reading the
 * agent's arguments. A reason not to start, or null.
 */
export function claudeProblem(path = process.env.PATH): string | null {
  if (!IS_WIN) return null;
  const found = Bun.which("claude", { PATH: path });
  if (!found || /\.exe$/i.test(found)) return null;
  return `claude on PATH is ${found}, which the harness cannot start without cmd.exe reading the agent's arguments — install Claude Code's native build, claude.exe: https://code.claude.com`;
}

// A process's command line and start, which is what tells a loop from a
// stranger who got its PID. ps has both. Windows has no ps that sees native
// processes (Git's is MSYS's own), so it asks CIM, with the PID in the
// environment rather than in the script.
const CIM =
  '$p = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$env:RALPH_PID)"; ' +
  'if ($p) { [Console]::Out.Write([string][int64](([DateTimeOffset]$p.CreationDate).ToUnixTimeSeconds()) + "`n" + $p.CommandLine) }';

function cimArgv(): string[] {
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", CIM];
}

function cimSplit(text: string): { started: number; command: string } | null {
  const nl = text.indexOf("\n");
  if (nl < 0) return null;
  return { started: Number(text.slice(0, nl)), command: text.slice(nl + 1).trim() };
}

// ps prints a command line in the caller's locale, and outside a UTF-8 one it
// escapes every byte past ASCII: macOS writes the ø in a loop directory as
// M-CM-8, and procps, going by its source, as ?. A `ralph status` from cron,
// launchd or an ssh session without LANG then matched nothing, calling a
// running loop stopped, and `ralph stop` left it running. In C.UTF-8 ps
// prints the bytes as they are.
const psEnv = () => ({ ...process.env, LC_ALL: "C.UTF-8" });

/** `pid`'s whole command line, or "" when it is not running. */
export function commandLineSync(pid: string): string {
  if (!IS_WIN) {
    const r = spawnSync("ps", ["-ww", "-p", pid, "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: psEnv(),
    });
    return (r.stdout ?? "").trimEnd();
  }
  const r = spawnSync(cimArgv()[0]!, cimArgv().slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, RALPH_PID: pid },
    windowsHide: true,
  });
  return cimSplit(r.stdout ?? "")?.command ?? "";
}

/** The same, through `run`, for the loop. */
export async function commandLine(pid: string): Promise<string> {
  if (!IS_WIN) return (await run(["ps", "-ww", "-p", pid, "-o", "command="], { env: psEnv() })).stdout;
  return cimSplit((await run(cimArgv(), { env: { ...process.env, RALPH_PID: pid } })).stdout)?.command ?? "";
}

/** How long `pid` has run, as ps's etime prints it: [[dd-]hh:]mm:ss. */
export function upTimeSync(pid: string): string {
  if (!IS_WIN) {
    const r = spawnSync("ps", ["-p", pid, "-o", "etime="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return (r.stdout ?? "").trim();
  }
  const r = spawnSync(cimArgv()[0]!, cimArgv().slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, RALPH_PID: pid },
    windowsHide: true,
  });
  const info = cimSplit(r.stdout ?? "");
  if (!info || !Number.isFinite(info.started)) return "";
  return etime(Math.max(0, Math.floor(Date.now() / 1000) - info.started));
}

export function etime(secs: number): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const lead = d ? `${d}-${two(h)}:` : h ? `${two(h)}:` : "";
  return `${lead}${two(m)}:${two(secs % 60)}`;
}

/** Seconds from what ps prints as etime, or null when it is not one. */
export function parseEtime(text: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

export interface Bounded {
  rc: number;
  timedOut: boolean;
}

export interface BoundedOptions {
  /** A file to read stdin from; nothing when absent. */
  stdin?: string;
  /** File stdout is appended to. */
  out: string;
  /** File stderr is appended to; `out` when absent. */
  err?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** The longest gap between two polls that counts as time the command had. */
  pollGapMax: number;
  /** A file that names the command while it runs, for `reapOrphan`. */
  mark?: string;
}

/**
 * Run a command in a process group of its own, for at most `secs` seconds the
 * machine was awake, with its output appended to files. Returns the exit status
 * rather than setting anything, so nothing that runs between a gate's command
 * and the gate's verdict (a notifier, say) can change what the gate reads.
 *
 * The budget is seconds awake, not wall clock. A suspended machine stops
 * polling and the clock jumps by the whole nap, so comparing now with the start
 * kills a healthy agent on the first poll after the wake: seen on a Mac asleep
 * 09:52 to 15:40, recorded as 22710s with the reason "timed out after 3600s" in
 * the same row. Summing the gaps is the same arithmetic while the machine is
 * awake — consecutive readings telescope to now minus start exactly — and a gap
 * longer than any poll asks for is a suspend, so it costs the budget
 * pollGapMax seconds and no more. A negative gap is the clock set back and
 * counts as nothing.
 */
export async function runBounded(secs: number, argv: string[], opts: BoundedOptions): Promise<Bounded> {
  // Not an opt-out: a tolerance of 0 or less falls back to the default rather
  // than to no cap, because no cap is the defect above.
  const cap = opts.pollGapMax >= 1 ? opts.pollGapMax : 60;
  const input = openSync(opts.stdin ?? DEV_NULL, "r");
  const errFile = opts.err ?? opts.out;
  const out = pumped ? "pipe" : openSync(opts.out, "a");
  const err = pumped ? "pipe" : errFile !== opts.out ? openSync(errFile, "a") : out;
  const [cmd, ...args] = argv;
  let child: ChildProcess | null = null;
  let refused = "";
  try {
    child = spawn(cmd!, args, {
      // A group of its own, to kill whole. Windows has no groups, and there a
      // detached child gets a console window of its own; the tree is killed.
      detached: !IS_WIN,
      windowsHide: true,
      stdio: [input, out, err],
      env: clean(opts.env ?? process.env),
      cwd: opts.cwd,
    });
  } catch (e) {
    refused = refusal(cmd!, e);
  }
  closeSync(input);
  if (typeof out === "number") closeSync(out);
  if (typeof err === "number" && err !== out) closeSync(err);
  if (!child) {
    try {
      appendFileSync(errFile, refused);
    } catch {}
    return settle({ rc: 127, timedOut: false });
  }
  const pumps = pumped ? [pumpTo(child.stdout, opts.out), pumpTo(child.stderr, errFile)] : [];
  const done = exited(child);
  const pid = child.pid;
  if (pid === undefined) {
    const rc = await done;
    await drained(child, pumps);
    return settle({ rc, timedOut: false });
  }
  enterJob(pid);
  current = { pid, done };
  // The wall clock, which is what ps's etime is read against, and not the
  // loop's clock. A mark that cannot be written costs only the cleanup after a
  // kill -9, so it does not stop the command.
  if (opts.mark) {
    try {
      writeFileSync(opts.mark, `${pid} ${Math.floor(Date.now() / 1000)}\n`);
    } catch {}
  }
  let finished = false;
  void done.then(() => {
    finished = true;
  });
  let timedOut = false;
  let last = nowSec();
  let elapsed = 0;
  let polls = 0;
  while (!finished) {
    const now = nowSec();
    let gap = now - last;
    last = now;
    if (gap < 0) gap = 0;
    if (gap > cap) gap = cap;
    elapsed += gap;
    if (elapsed >= secs) {
      timedOut = true;
      await killGroup(pid, done);
      break;
    }
    // Fast at first, so a quick command (git push, a short VERIFY_CMD) does
    // not cost two seconds each.
    await Promise.race([done, sleep(polls < 20 ? 100 : 2000)]);
    polls++;
  }
  const rc = await done;
  await drained(child, pumps);
  leaveJob(pid);
  current = null;
  if (opts.mark) rmSync(opts.mark, { force: true });
  return settle({ rc, timedOut });
}

/**
 * Stop the command a mark names, if it is still running, and say which PID
 * that was. A loop killed with no chance to run its handler (kill -9, the OOM
 * killer, bun crashing) leaves its bounded command running in a group of its
 * own, and nothing reaches it after that: `ralph status` and `ralph stop` find
 * no loop, and the next start ran a second agent beside it in the same
 * checkout. The loop holding the lock calls this before it starts anything,
 * and `ralph stop` when it finds no loop running.
 *
 * A PID is not an identity, so the start the mark recorded has to match the
 * one ps gives now, to within the second etime is rounded to. And a command
 * whose parent is a running loop is that loop's, not an orphan: a dead loop's
 * command has been handed to init or a subreaper, and a loop the CLI could not
 * find (its ralph.lock gone, or written a moment after the CLI looked) is
 * still the parent of what it runs. Not on Windows yet: nothing here has been
 * run there.
 */
export async function reapOrphan(mark: string): Promise<number | null> {
  if (IS_WIN) return null;
  let text: string;
  try {
    text = readFileSync(mark, "utf8");
  } catch {
    return null;
  }
  const m = /^(\d+) (\d+)\n$/.exec(text);
  let pid = 0;
  if (m && alive(Number(m[1]))) {
    const ppid = markedParent(Number(m[2]), (await run(["ps", "-p", m[1]!, "-o", "etime=", "-o", "ppid="])).stdout);
    if (ppid !== null) {
      if (/^\d+$/.test(ppid) && (await commandLine(ppid)).includes(LOOP_MARK)) return null;
      pid = Number(m[1]);
    }
  }
  if (pid) await killGroup(pid);
  // Only the mark read above: a loop started during the wait for the group to
  // go has written its own.
  let now = "";
  try {
    now = readFileSync(mark, "utf8");
  } catch {}
  if (now === text) rmSync(mark, { force: true });
  return pid || null;
}

/**
 * The PID `reapOrphan` would stop, without stopping it or touching the mark,
 * for a reader that only reports. `ralph status` said `stopped` while the
 * command a killed loop left behind ran on, its agent unbounded and writing
 * into the checkout, and gave no reason to run the `ralph stop` that ends it.
 */
export function orphanSync(mark: string): number | null {
  if (IS_WIN) return null;
  let m: RegExpExecArray | null;
  try {
    m = /^(\d+) (\d+)\n$/.exec(readFileSync(mark, "utf8"));
  } catch {
    return null;
  }
  if (!m || !alive(Number(m[1]))) return null;
  const ps = spawnSync("ps", ["-p", m[1]!, "-o", "etime=", "-o", "ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const ppid = markedParent(Number(m[2]), ps.stdout ?? "");
  if (ppid === null || (/^\d+$/.test(ppid) && commandLineSync(ppid).includes(LOOP_MARK))) return null;
  return Number(m[1]);
}

/**
 * The parent PID from `ps -o etime= -o ppid=`, when the start that gives
 * matches the one a mark recorded, to within the second etime is rounded to;
 * null when it does not, and the PID is somebody else's now.
 */
function markedParent(started: number, ps: string): string | null {
  const [etime = "", ppid = ""] = ps.trim().split(/\s+/);
  const up = parseEtime(etime);
  if (up === null || Math.abs(Math.floor(Date.now() / 1000) - up - started) > 2) return null;
  return ppid;
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Text for stdin. */
  input?: string;
  /** A file stderr is appended to (the log), instead of capturing it. */
  errTo?: string;
  /** A file stdout is appended to, instead of capturing it. */
  outTo?: string;
}

/**
 * Run a short command to completion and capture its output. Not bounded and
 * not in a group of its own: git and the like, whose failure is its exit code.
 */
export async function run(argv: string[], opts: RunOptions = {}): Promise<Ran> {
  const [cmd, ...args] = argv;
  const errFd = opts.errTo && !pumped ? openSync(opts.errTo, "a") : null;
  const outFd = opts.outTo && !pumped ? openSync(opts.outTo, "a") : null;
  let child: ChildProcess | null = null;
  let refused = "";
  try {
    child = spawn(cmd!, args, {
      stdio: [opts.input === undefined ? "ignore" : "pipe", outFd ?? "pipe", errFd ?? "pipe"],
      env: clean(opts.env ?? process.env),
      cwd: opts.cwd,
      windowsHide: true,
    });
  } catch (e) {
    refused = refusal(cmd!, e);
  }
  if (errFd !== null) closeSync(errFd);
  if (outFd !== null) closeSync(outFd);
  if (!child) {
    if (opts.errTo) {
      try {
        appendFileSync(opts.errTo, refused);
      } catch {}
    }
    return settle({ code: 127, stdout: "", stderr: opts.errTo ? "" : refused });
  }
  plainChildren.add(child);
  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  if (pumped && opts.outTo) void pumpTo(child.stdout, opts.outTo);
  else child.stdout?.on("data", (b: Buffer) => chunks.push(b));
  if (pumped && opts.errTo) void pumpTo(child.stderr, opts.errTo);
  else child.stderr?.on("data", (b: Buffer) => errChunks.push(b));
  if (opts.input !== undefined && child.stdin) {
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input);
  }
  const code = await new Promise<number>((resolve) => {
    let done = false;
    child.once("close", (c, s) => {
      if (!done) {
        done = true;
        resolve(exitCode(c, s));
      }
    });
    // A pumped file is a pipe, which a background grandchild can hold open
    // after the command itself is gone; a descriptor never made anyone wait.
    if (pumped && (opts.outTo || opts.errTo)) {
      child.once("exit", (c, s) => {
        setTimeout(() => {
          if (!done) {
            done = true;
            child.stdout?.destroy();
            child.stderr?.destroy();
            resolve(exitCode(c, s));
          }
        }, 2000);
      });
    }
    child.once("error", () => {
      if (!done) {
        done = true;
        resolve(127);
      }
    });
  });
  plainChildren.delete(child);
  return settle({
    code,
    stdout: Buffer.concat(chunks).toString("utf8"),
    stderr: Buffer.concat(errChunks).toString("utf8"),
  });
}

/**
 * Why the system would not start a command, as a line for where its output
 * goes. A start it refuses throws from `spawn` instead of erroring later: an
 * environment past the system's size limit (E2BIG), or a NUL byte in a
 * variable or an argument, which none can hold. Thrown, it ended the loop from
 * inside a notifier, and the "stopped" notice after it threw the same way, so
 * the human heard nothing. So it is a command that did not run, 127, as one
 * that is not there.
 */
function refusal(cmd: string, e: unknown): string {
  const why = (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
  // The message can quote the value that held the NUL.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return `${cmd}: could not start: ${[...why.replace(/[\x00-\x1f\x7f]/g, " ")].slice(0, 300).join("")}\n`;
}

function clean(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}
