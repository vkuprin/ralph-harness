#!/usr/bin/env bun
// The loop process: one per loop directory.
//
//   bun src/loop/main.ts <loop-dir>      (or RALPH_LOOP=<loop-dir>)
//
// `ralph start <name>` runs this in the background. The loop directory holds
// config.json, PROMPT.md and PROGRESS.md; `ralph new <name> <repo>` makes one.
import { existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync, closeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadConfig } from "../lib/config.ts";
import { Log } from "../lib/log.ts";
import { IS_WIN, commandLine, current, freeze, killGroup, plainChildren, reapOrphan } from "../lib/proc.ts";
import { hint } from "../lib/shq.ts";
import { CHILD_FILE, LOOP_MARK, REFUSED, STARTED_FILE, STOP_FILE } from "../paths.ts";
import { Loop, Stop, missingFile } from "./loop.ts";

// The suite's stand-in for bun never finishing loading this file, which
// `ralph start` has to notice: with the file there, it is taken away and this
// process hangs before its first line, as the real hang does. Unset outside the
// suite, like RALPH_TEST_CLOCK.
const bootHang = process.env.RALPH_TEST_BOOT_HANG;
if (bootHang && existsSync(bootHang)) {
  rmSync(bootHang, { force: true });
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}

const arg = process.argv[2] || process.env.RALPH_LOOP || "";
if (!arg) {
  process.stderr.write("usage: bun src/loop/main.ts <loop-dir>\n");
  process.exit(REFUSED);
}
const dir = resolve(arg);
let isDir = false;
try {
  isDir = statSync(dir).isDirectory();
} catch {}
if (!isDir) {
  process.stderr.write(`ralph: no such loop directory: ${arg}\n`);
  process.exit(REFUSED);
}

// The harness's own errors belong in ralph.log, which is where `ralph log`,
// `ralph tail` and `ralph status` read and where a human is sent. Every fatal
// from here on says its piece through the log, which writes to stdout as well,
// so a hand-run in a terminal still hears it.
const log = new Log(join(dir, "ralph.log"));
const name = basename(dir);

// Settings from before this harness are in config.sh, which is bash and which
// nothing here will source. Say how to convert them rather than "missing".
if (!existsSync(join(dir, "config.json")) && existsSync(join(dir, "config.sh"))) {
  log.line(
    `ralph: ${dir} keeps its settings in config.sh, which this harness does not read — convert them: ${hint("ralph", "migrate", name)}`,
  );
  process.exit(REFUSED);
}

// Every one of them is a regular file this process can read. Called again
// before every iteration: config.json is read once on purpose, but PROMPT.md
// and PROGRESS.md are re-read for every prompt, and the agent can write here.
const gone = missingFile(dir, "config.json", "PROMPT.md", "PROGRESS.md");
if (gone) {
  log.line(`ralph: loop is missing ${gone}: ${join(dir, gone)}`);
  process.exit(REFUSED);
}

const loaded = loadConfig(join(dir, "config.json"), dir);
if (!loaded.ok) {
  // Half a config is not a config. NOTIFY_CMD is in the file that could not be
  // read, so this refusal cannot notify anyone; the log is all there is.
  log.line(loaded.error);
  process.exit(REFUSED);
}
const loop = new Loop(dir, loaded.config, log);

// One loop process per loop directory. Two would share PROGRESS.md, the log and
// the worktree, and each would take the other's commits for its own. The lock
// is taken with O_EXCL, so two starts at once cannot both win it.
const LOCK = join(dir, "ralph.lock");

/**
 * A PID is not an identity: a loop killed by `kill -9`, the OOM killer or a
 * reboot leaves its lock behind, and the number is then somebody else's. The
 * holder has to be running a ralph loop — this harness's, or the bash one it
 * replaced — or the lock is stale.
 */
async function lockHolder(): Promise<string | null> {
  let pid: string;
  try {
    pid = readFileSync(LOCK, "utf8").trim();
  } catch {
    return null;
  }
  if (!/^\d+$/.test(pid)) return null;
  try {
    process.kill(Number(pid), 0);
  } catch {
    return null;
  }
  const cmd = await commandLine(pid);
  return cmd.includes(LOOP_MARK) || /ralph.*\.sh/.test(cmd) ? pid : null;
}

function takeLock(): boolean {
  try {
    const fd = openSync(LOCK, "wx");
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the lock, or refuse: called once the loop has passed every check, so a
 * loop holding ralph.lock is one that runs.
 */
async function lock(): Promise<void> {
  if (!takeLock()) {
    const holder = await lockHolder();
    if (holder === null) rmSync(LOCK, { force: true });
    if (holder !== null || !takeLock()) {
      log.line(`ralph: this loop is already running as PID ${holder ?? (await lockHolder()) ?? "?"}: ${dir}`);
      process.exit(REFUSED);
    }
  }
  process.on("exit", () => {
    try {
      if (readFileSync(LOCK, "utf8").trim() === String(process.pid)) rmSync(LOCK, { force: true });
    } catch {}
  });

  // Windows has no TERM to send: process.kill there ends a process on the spot,
  // with no handler run and the agent under it left running on its own. So
  // `ralph stop` asks through a file, and the loop answers it exactly as it
  // answers a signal. One left behind by a loop that was killed means nothing.
  // Only once the lock is ours: before that the file is the running loop's.
  if (IS_WIN) {
    const stopFile = join(dir, STOP_FILE);
    rmSync(stopFile, { force: true });
    setInterval(() => {
      if (!existsSync(stopFile)) return;
      rmSync(stopFile, { force: true });
      void onSignal();
    }, 250).unref();
  }

  // What the last run of this loop was running when it died without its handler
  // is still running, an agent in this loop's checkout, say. With the lock held
  // it can only be that run's, so it goes as the handler would have sent it,
  // before anything here starts beside it.
  const orphan = await reapOrphan(join(dir, CHILD_FILE));
  if (orphan !== null) {
    log.line(
      `start: PID ${orphan}, which the last run of this loop left running when it died, was still running; stopped it and its process group`,
    );
  }
  loop.holdsLock = true;
}

// The CLI writes ralph.pid; clearing it here keeps `ralph status` honest.
let stopping = false;
async function onSignal(): Promise<void> {
  if (stopping) return;
  stopping = true;
  freeze();
  if (current) await killGroup(current.pid, current.done);
  for (const c of plainChildren) c.kill("SIGTERM");
  rmSync(join(dir, "ralph.pid"), { force: true });
  log.line(`ralph stopped by signal during iteration ${loop.iter}`);
  process.exit(130);
}
process.on("SIGTERM", () => void onSignal());
process.on("SIGINT", () => void onSignal());
process.on("SIGHUP", () => {});

try {
  await loop.check();
  await lock();
  await loop.start();
  // The worktree, SETUP_CMD and the rest of the start are behind the lock, and
  // a loop that refuses one of them is gone a moment after `ralph start` saw
  // it take the lock; so that waits for this too.
  writeFileSync(join(dir, STARTED_FILE), `${process.pid}\n`);
  await loop.run();
} catch (e) {
  if (e instanceof Stop) process.exit(e.code);
  const why = e instanceof Error ? (e.stack ?? e.message) : String(e);
  log.line(`ralph: internal error — ${why}`);
  rmSync(join(dir, "ralph.pid"), { force: true });
  await loop.notify("stopped", `internal error: ${e instanceof Error ? e.message : String(e)} (after ${loop.iter} iterations)`);
  process.exit(1);
}
process.exit(0);
