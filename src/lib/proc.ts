import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { constants } from "node:os";
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

/**
 * TERM the whole group, give it up to ten seconds, then KILL the group. The
 * KILL goes out whether or not the leader has gone: a leader that exits on TERM
 * can leave children behind in its group that ignore it.
 */
export async function killGroup(pid: number, done?: Promise<number>): Promise<void> {
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
  const input = openSync(opts.stdin ?? "/dev/null", "r");
  const out = openSync(opts.out, "a");
  const err = opts.err && opts.err !== opts.out ? openSync(opts.err, "a") : out;
  const [cmd, ...args] = argv;
  const child = spawn(cmd!, args, {
    detached: true,
    stdio: [input, out, err],
    env: clean(opts.env ?? process.env),
    cwd: opts.cwd,
  });
  closeSync(input);
  closeSync(out);
  if (err !== out) closeSync(err);
  const done = exited(child);
  const pid = child.pid;
  if (pid === undefined) {
    return settle({ rc: await done, timedOut: false });
  }
  current = { pid, done };
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
  current = null;
  return settle({ rc, timedOut });
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
  const errFd = opts.errTo ? openSync(opts.errTo, "a") : null;
  const outFd = opts.outTo ? openSync(opts.outTo, "a") : null;
  const child = spawn(cmd!, args, {
    stdio: [opts.input === undefined ? "ignore" : "pipe", outFd ?? "pipe", errFd ?? "pipe"],
    env: clean(opts.env ?? process.env),
    cwd: opts.cwd,
  });
  if (errFd !== null) closeSync(errFd);
  if (outFd !== null) closeSync(outFd);
  plainChildren.add(child);
  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  child.stdout?.on("data", (b: Buffer) => chunks.push(b));
  child.stderr?.on("data", (b: Buffer) => errChunks.push(b));
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

function clean(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}
