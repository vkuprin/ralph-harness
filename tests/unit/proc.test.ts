import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { etime, killGroup, run, runBounded, shellCommand } from "../../src/lib/proc.ts";
import { endsWithArg, markThen } from "../../src/paths.ts";

const T = realpathSync(mkdtempSync(join(tmpdir(), "ralph-unit-proc.")));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("runBounded", () => {
  afterEach(() => {
    delete process.env.RALPH_TEST_CLOCK;
  });

  test("returns the exit status and appends both streams to the file", async () => {
    const out = join(T, "a.out");
    writeFileSync(out, "before\n");
    const r = await runBounded(10, ["sh", "-c", "echo one; echo two >&2; exit 3"], { out, pollGapMax: 60 });
    expect(r).toEqual({ rc: 3, timedOut: false });
    expect(readFileSync(out, "utf8")).toBe("before\none\ntwo\n");
  });

  test("a command that is not there exits 127", async () => {
    const r = await runBounded(10, ["no-such-command-for-ralph"], { out: join(T, "b.out"), pollGapMax: 60 });
    expect(r.rc).toBe(127);
  });

  test("a timeout kills the whole process group, grandchildren included", async () => {
    const pidFile = join(T, "grandchild.pid");
    const r = await runBounded(1, ["sh", "-c", `sleep 30 & echo $! > '${pidFile}'; wait`], {
      out: join(T, "c.out"),
      pollGapMax: 60,
    });
    expect(r.timedOut).toBe(true);
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    // On Windows `taskkill /T /F` can return before the tree is torn down, so
    // one look 200ms later sometimes still found the grandchild. Look for up to 5s.
    for (let i = 0; i < 50 && alive(grandchild); i++) await Bun.sleep(100);
    expect(alive(grandchild)).toBe(false);
  });

  test("time asleep is not time worked: a clock jump costs one gap", async () => {
    const clock = join(T, "clock");
    writeFileSync(clock, "0");
    process.env.RALPH_TEST_CLOCK = clock;
    // Jump the clock by 20000s half a second in; the command still has its 5s.
    setTimeout(() => writeFileSync(clock, "20000"), 500);
    const r = await runBounded(5, ["sh", "-c", "sleep 1.5"], { out: join(T, "d.out"), pollGapMax: 2 });
    expect(r).toEqual({ rc: 0, timedOut: false });
  });

  test("a POLL_GAP_MAX of 0 is the default cap, not no cap", async () => {
    const clock = join(T, "clock0");
    writeFileSync(clock, "0");
    process.env.RALPH_TEST_CLOCK = clock;
    setTimeout(() => writeFileSync(clock, "20000"), 500);
    const r = await runBounded(600, ["sh", "-c", "sleep 1.5"], { out: join(T, "e.out"), pollGapMax: 0 });
    expect(r.timedOut).toBe(false);
  });
});

describe("run", () => {
  test("captures stdout and the exit status, and feeds stdin", async () => {
    const r = await run(["sh", "-c", "cat; exit 4"], { input: "hello" });
    expect(r.code).toBe(4);
    expect(r.stdout).toBe("hello");
  });

  test("appends stderr to a file when asked", async () => {
    const log = join(T, "run.log");
    await run(["sh", "-c", "echo oops >&2"], { errTo: log });
    expect(readFileSync(log, "utf8")).toBe("oops\n");
  });
});

describe("killGroup", () => {
  test("ends a group whose leader ignores TERM", async () => {
    const { spawn } = await import("node:child_process");
    const c = spawn("sh", ["-c", "trap '' TERM; sleep 30"], { detached: true, stdio: "ignore" });
    await Bun.sleep(100);
    const t0 = Date.now();
    await killGroup(c.pid!);
    expect(Date.now() - t0).toBeLessThan(12_000);
    await Bun.sleep(100);
    expect(alive(c.pid!)).toBe(false);
  }, 20_000);
});

describe("etime", () => {
  test("prints elapsed seconds the way ps does", () => {
    expect(etime(5)).toBe("00:05");
    expect(etime(3599)).toBe("59:59");
    expect(etime(3600)).toBe("01:00:00");
    expect(etime(2 * 86400 + 3 * 3600 + 4 * 60 + 5)).toBe("2-03:04:05");
  });
});

describe("reading a loop off a command line", () => {
  const win = process.platform === "win32";
  test("the directory has to be the last argument, literally", () => {
    expect(endsWithArg("bun /h/src/loop/main.ts /loops/a", "/loops/a")).toBe(true);
    expect(endsWithArg("bun /h/src/loop/main.ts /loops/ab", "/loops/a")).toBe(false);
    expect(endsWithArg("bun /h/src/loop/main.ts /loops/a.b", "/loops/a?b")).toBe(false);
  });
  test("the entry has to be followed by more", () => {
    expect(markThen("bun /h/src/loop/main.ts /loops/a", "/src/loop/main.ts")).toBe(true);
    expect(markThen("bun /h/src/loop/main.tsx /loops/a", "/src/loop/main.ts")).toBe(false);
  });
  test("Windows writes an argument holding a space in quotes, and only there does that count", () => {
    const cmd = 'C:\\bun.exe "C:\\my harness\\src\\loop\\main.ts" "C:\\Users\\a b\\ralph\\x"';
    expect(endsWithArg(cmd, "C:\\Users\\a b\\ralph\\x")).toBe(win);
    expect(markThen(cmd, "\\src\\loop\\main.ts")).toBe(win);
  });
});

describe("shellCommand", () => {
  // Windows hands a program one command line, and an MSYS bash cuts it up
  // itself: a command with no space in it once lost its single quotes there.
  test("bash gets the text as written, quotes and globs and all", async () => {
    const out = join(T, "shell.out");
    const words = ["'lone'", "'a  b'", '"c d"', "'*.ts'", "'x|y'"];
    for (const w of words) {
      writeFileSync(out, "");
      const sh = shellCommand(`printf '%s\n' ${w}`);
      const r = await runBounded(10, sh.argv, { out, env: { ...process.env, ...sh.env }, pollGapMax: 60 });
      expect(r.rc).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(`${w.slice(1, -1)}\n`);
    }
  });
  test("a script's path in single quotes, with nothing else, runs the script", async () => {
    // The exact shape that broke: no space anywhere, so nothing but the single
    // quotes kept a Windows path's backslashes from bash.
    const script = join(T, "ok.sh");
    writeFileSync(script, "#!/bin/sh\necho ok\n");
    chmodSync(script, 0o755);
    const out = join(T, "shell2.out");
    writeFileSync(out, "");
    const sh = shellCommand(`'${script}'`);
    const r = await runBounded(10, sh.argv, { out, env: { ...process.env, ...sh.env }, pollGapMax: 60 });
    expect(readFileSync(out, "utf8")).toBe("ok\n");
    expect(r.rc).toBe(0);
  });
});
