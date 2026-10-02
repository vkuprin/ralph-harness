// Scratch, never merged: what each way of killing a hung `git fetch` leaves of
// its ssh transport on Windows, and what the process tree looks like first.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pwsh = (q: string) =>
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", q], { encoding: "utf8" }).stdout ?? "";

function cim(mark: string): string {
  return pwsh(
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${mark}*' -or $_.Name -like 'git*' -or $_.Name -like 'ssh*' } | ` +
      `Select-Object ProcessId,ParentProcessId,Name,CommandLine | Format-Table -AutoSize -Wrap | Out-String -Width 260`,
  );
}

function survivors(mark: string): number[] {
  const out = pwsh(
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${mark}*' } | ForEach-Object { $_.ProcessId }`,
  );
  return out
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => n !== process.pid);
}

function msysPs(): string {
  return spawnSync("ps", ["-el"], { encoding: "utf8" }).stdout ?? "";
}

const k32 = dlopen("kernel32.dll", {
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
  AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
  GetLastError: { args: [], returns: FFIType.u32 },
});

const variants: Record<string, (m: string) => string> = {
  exec: (m) => `sh -c 'exec sh -c "sleep 611; :" ${m}' --`,
  noexec: (m) => `sh -c 'sh -c "sleep 611; :" ${m}; :' --`,
  direct: (m) => `sh -c "sleep 611; :" ${m}`,
};

const base = mkdtempSync(join(tmpdir(), "tree-"));
const git = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" });

for (const method of ["taskkill", "job"]) {
  for (const [vname, cmd] of Object.entries(variants)) {
    const mark = `MARK_${method}_${vname}`;
    const repo = join(base, mark);
    spawnSync("git", ["init", "-q", repo]);
    git(repo, "remote", "add", "origin", "ssh://hang.invalid/x");
    git(repo, "config", "core.sshCommand", cmd(mark));
    console.log(`\n========== ${method} / ${vname}`);
    const child = spawn("git", ["fetch", "-q", "origin", "main"], { cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let job: unknown = null;
    if (method === "job") {
      job = k32.symbols.CreateJobObjectW(null, null);
      const h = k32.symbols.OpenProcess(0x0101, false, child.pid!);
      const ok = k32.symbols.AssignProcessToJobObject(job as never, h as never);
      console.log(`job=${String(job)} handle=${String(h)} assigned=${ok} err=${k32.symbols.GetLastError()}`);
      k32.symbols.CloseHandle(h as never);
    }
    const exited = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
    await sleep(4000);
    console.log(`git pid ${child.pid}; before the kill (CIM):\n${cim(mark)}`);
    console.log(`MSYS ps -el before:\n${msysPs()}`);
    if (method === "taskkill") {
      const r = spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { encoding: "utf8" });
      console.log(`taskkill rc=${r.status}\n${r.stdout}${r.stderr}`);
    } else {
      console.log(`TerminateJobObject=${k32.symbols.TerminateJobObject(job as never, 1)} err=${k32.symbols.GetLastError()}`);
    }
    const code = await Promise.race([exited, sleep(5000).then(() => "no exit event in 5s")]);
    console.log(`git exit: ${code}`);
    await sleep(2000);
    const left = survivors(mark);
    console.log(`RESULT ${method}/${vname}: ${left.length} left alive: ${left.join(" ")}`);
    if (left.length) console.log(cim(mark));
    for (const pid of left) spawnSync("taskkill", ["/F", "/PID", String(pid)]);
  }
}
