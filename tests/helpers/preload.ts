import { afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Strangers: processes this run does not own and must not notice. A `sleep 999`
// is a thing a human types in another terminal, and a second copy of this suite
// has a soak loop with `home-soak` on its command line. Both once turned process
// checks red, and this suite is what a loop on this repository runs as its
// VERIFY_CMD — so an unrelated process reset a commit that was fine. They run
// for the whole suite on purpose, so every check is made in their company; a
// check that asserts about the whole machine fails the moment it is written.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "ralph-stranger.")));
const sleeper = spawn("sleep", ["999"], { stdio: "ignore" });
const soak = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", join(dir, "home-soak-decoy")], {
  stdio: "ignore",
});
sleeper.unref();
soak.unref();

export interface Strangers {
  sleep: number;
  soak: number;
  dir: string;
}
(globalThis as { ralphStrangers?: Strangers }).ralphStrangers = { sleep: sleeper.pid!, soak: soak.pid!, dir };

// A global afterAll, not process.on("exit"): under `bun test` the exit event
// never reaches a preload, and the strangers outlived every run.
afterAll(() => {
  sleeper.kill("SIGKILL");
  soak.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});
