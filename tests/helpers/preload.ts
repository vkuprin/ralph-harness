import { afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

// Windows starts no script by its #! line, and the harness finds claude.exe on
// PATH and never a batch file, so there the stand-ins for claude and gh are
// compiled into programs, once per run, into this run's own directory.
if (process.platform === "win32") {
  const bin = join(dir, "stub-bin");
  // Copied to .ts first: with no extension the bundler takes a stub for an
  // asset, and the program it builds does nothing at all.
  const src = join(dir, "stub-src");
  mkdirSync(src);
  const stubs = join(import.meta.dir, "../stub");
  copyFileSync(join(stubs, "human.ts"), join(src, "human.ts"));
  for (const name of ["claude", "gh"]) {
    copyFileSync(join(stubs, name), join(src, `${name}.ts`));
    // A compile takes a second. On a CI runner one once hung for good, before
    // the first test and with nothing to say so, and took the job with it: so
    // each try is bounded, a hung one is tried again, and the last says why.
    let built = false;
    let why = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = Bun.spawnSync(
        [process.execPath, "build", "--compile", join(src, `${name}.ts`), "--outfile", join(bin, `${name}.exe`)],
        { stdout: "ignore", stderr: "pipe", timeout: 120_000 },
      );
      if (r.exitCode === 0) {
        built = true;
        break;
      }
      // Success is the exit status, never an empty stderr: a compile killed
      // before it said anything is still no stub.
      why = r.exitedDueToTimeout
        ? `bun build --compile hung for 120s, ${attempt} times`
        : r.stderr.toString().trim() || `bun build --compile exited ${r.exitCode ?? r.signalCode}`;
      if (!r.exitedDueToTimeout) break;
    }
    if (!built) throw new Error(`cannot compile tests/stub/${name}: ${why}`);
  }
  (globalThis as { ralphStubBin?: string }).ralphStubBin = bin;
}
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
