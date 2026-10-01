import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Where the harness itself lives. Bun resolves a symlinked entry point to the
// real file, so `ln -s <checkout>/bin/ralph ~/.local/bin/ralph` still finds
// template/ and hooks/ next to the real checkout.
export const HARNESS = realpathSync(resolve(import.meta.dir, ".."));
export const LOOP_ENTRY = join(HARNESS, "src/loop/main.ts");
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

export function ralphHome(): string {
  return process.env.RALPH_HOME || join(homedir(), ".claude/ralph");
}
