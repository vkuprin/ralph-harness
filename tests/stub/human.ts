// A human somewhere else: acts in a fresh clone of the test's remote
// ($STUB_REMOTE), without the push block the harness gives the agent. Shared by
// the claude stub (a human pushing, squash-merging) and the gh stub (GitHub
// merging a pull request).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function humanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_CONFIG_KEY_0;
  delete env.GIT_CONFIG_VALUE_0;
  return env;
}

/** Run each command in the clone at `<stubDir>/human-clone`, on a fresh origin/main; false at the first failure. */
export function human(stubDir: string, ...commands: string[][]): boolean {
  const env = humanEnv();
  const clone = join(stubDir, "human-clone");
  const run = (args: string[], cwd?: string) =>
    spawnSync(args[0]!, args.slice(1), { cwd, env, stdio: ["ignore", "ignore", "ignore"] }).status === 0;
  if (!existsSync(clone) && !run(["git", "clone", "-q", process.env.STUB_REMOTE ?? "", clone])) return false;
  if (!run(["git", "fetch", "-q", "origin"], clone)) return false;
  if (!run(["git", "checkout", "-q", "-B", "main", "origin/main"], clone)) return false;
  for (const c of commands) if (!run(c, clone)) return false;
  return true;
}

export function humanOut(stubDir: string, ...args: string[]): string {
  return (spawnSync("git", args, { cwd: join(stubDir, "human-clone"), env: humanEnv(), encoding: "utf8" }).stdout ?? "").trim();
}
