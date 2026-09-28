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

/** What names a process as a loop of this harness on its command line. */
export const LOOP_MARK = "/src/loop/main.ts";

export function ralphHome(): string {
  return process.env.RALPH_HOME || join(homedir(), ".claude/ralph");
}
