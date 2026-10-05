import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Where the harness itself lives. Bun resolves a symlinked entry point to the
// real file, so `ln -s <checkout>/bin/ralph ~/.local/bin/ralph` still finds
// template/ and hooks/ next to the real checkout.
export const HARNESS = realpathSync(resolve(import.meta.dir, ".."));
export const LOOP_ENTRY = join(HARNESS, "src/loop/main.ts");
/** The CLI, which a loop runs as `ralph start` to start NEXT_LOOP. */
export const CLI_ENTRY = join(HARNESS, "src/cli/main.ts");
export const STEER_HOOK = join(HARNESS, "hooks/steer.ts");
export const APPROVE_PLAN = join(HARNESS, "hooks/approve-plan.ts");
export const TEMPLATE = join(HARNESS, "template");

/** What names a process as a loop of this harness on its command line: `\src\loop\main.ts` on Windows. */
export const LOOP_MARK = join("/src/loop/main.ts");

// A command line read back from ps or CIM is matched literally, never as a
// pattern. Windows writes an argument that holds a space in double quotes, so
// there the quoted form counts too.
const WIN = process.platform === "win32";

/** `cmd` has an argument ending in `mark` with more after it. */
export function markThen(cmd: string, mark: string): boolean {
  return cmd.includes(`${mark} `) || (WIN && cmd.includes(`${mark}" `));
}

/** `cmd` ends with the argument `word`. */
export function endsWithArg(cmd: string, word: string): boolean {
  return cmd.endsWith(` ${word}`) || (WIN && cmd.endsWith(` "${word}"`));
}

/** Where the loop answers `ralph stop` on Windows, which has no TERM to send it. */
export const STOP_FILE = "ralph.stop";

/** Where the loop names the bounded command it is running, for the next start if it dies first. */
export const CHILD_FILE = ".child";

/** Where the loop writes its PID once its start is done (worktree, setup), which `ralph start` waits for. */
export const STARTED_FILE = ".started";

/**
 * Where loop `name` keeps the commits a gate threw away, `ns` being "reverted"
 * or "dropped": refs/ralph/<name>/<ns>/<epoch>-<iteration>. A prefix for
 * for-each-ref, and a literal one: git refuses `* ? [ \` in a branch, so in a
 * loop's name too.
 */
export function refPrefix(name: string, ns: string): string {
  return `refs/ralph/${name}/${ns}/`;
}

/**
 * Where an older version kept them, for every loop on the repository alike:
 * refs/ralph/<ns>/<epoch>-<iteration>. A loop named "reverted" keeps its own
 * one level further down, so only a ref with nothing after <ns>/ but the epoch
 * is one of these.
 */
export const LEGACY_REFS = ["refs/ralph/reverted/", "refs/ralph/dropped/"];
export const isLegacyRef = (ref: string) => LEGACY_REFS.some((p) => ref.startsWith(p) && !ref.slice(p.length).includes("/"));

/** Newest first, by the epoch in the last part of the name, numerically. */
export function sortRefs(refs: string[]): string[] {
  const epoch = (r: string) => Number.parseInt(r.slice(r.lastIndexOf("/") + 1), 10) || 0;
  return refs.sort((a, b) => epoch(b) - epoch(a) || (a < b ? 1 : a > b ? -1 : 0));
}

/**
 * The loop's exit status for a start it refused before taking ralph.lock: a
 * setting or a file it could not read, or another loop holding the lock.
 * Nothing after the lock exits with it (a worktree it cannot use exits 1, as a
 * loop that ran and stopped does), so `ralph start` reads it as "did not
 * start" whenever it comes.
 */
export const REFUSED = 2;

export function ralphHome(): string {
  return process.env.RALPH_HOME || join(homedir(), ".claude/ralph");
}
