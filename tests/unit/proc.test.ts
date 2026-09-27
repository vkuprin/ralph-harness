import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killGroup, run, runBounded } from "../../src/lib/proc.ts";

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
    await Bun.sleep(200);
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
