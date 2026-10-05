// What `ralph start` runs through WMI on Windows when the shell that ran it
// keeps its processes in a job that lets nothing leave (an agent's shell tool):
// a process WMI starts is outside that job, and a `ralph start` it runs can
// take the loop out of every job it is in.
//
// WMI starts it with the service's environment, so the caller's comes in a
// file, read and removed before anything else. Usage:
//   bun relaunch.ts <env-file> <out-file> <argv...>
// It runs argv with that environment, its output into <out-file>, and writes
// the exit status into <out-file>.rc when it is done, which is what the
// waiting `ralph start` reads.
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const [envFile, outFile, ...argv] = process.argv.slice(2);
if (!envFile || !outFile || argv.length === 0) process.exit(2);

function readOnce(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } finally {
    rmSync(file, { force: true });
  }
}

const env = JSON.parse(readOnce(envFile)) as Record<string, string>;
const fd = openSync(outFile, "w");
let rc = 1;
try {
  rc = Bun.spawnSync(argv, { env, stdin: "ignore", stdout: fd, stderr: fd, windowsHide: true }).exitCode ?? 1;
} finally {
  closeSync(fd);
  writeFileSync(`${outFile}.rc`, `${rc}\n`);
}
