import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { etime, killGroup, parseEtime, reapOrphan, run, runBounded, shellCommand } from "../../src/lib/proc.ts";
import { endsWithArg, markThen } from "../../src/paths.ts";

const T = realpathSync(mkdtempSync(join(tmpdir(), "ralph-unit-proc.")));
const IS_WIN = process.platform === "win32";
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
    // The grandchild writes its own PID once it runs. `$!` from Git's sh is an
    // MSYS PID, and a kill that lands while sh is still forking races the
    // tree's creation: `taskkill /T` kills only the processes it listed, and a
    // child born a moment later is orphaned. So the timeout fires (through the
    // clock) only once the whole tree is there.
    const clock = join(T, "clock-tree");
    writeFileSync(clock, "0");
    process.env.RALPH_TEST_CLOCK = clock;
    const pidFile = join(T, "grandchild.pid");
    const script = join(T, "grandchild.js");
    writeFileSync(script, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000);`);
    const slash = (p: string) => p.split("\\").join("/");
    const bounded = runBounded(30, ["sh", "-c", `'${slash(process.execPath)}' '${slash(script)}' & wait`], {
      out: join(T, "c.out"),
      pollGapMax: 60,
    });
    let grandchild = 0;
    for (let i = 0; i < 100 && !grandchild; i++) {
      await Bun.sleep(100);
      try {
        grandchild = Number(readFileSync(pidFile, "utf8").trim());
      } catch {}
    }
    expect(grandchild).toBeGreaterThan(0);
    writeFileSync(clock, "1000");
    const r = await bounded;
    expect(r.timedOut).toBe(true);
    // The tree can take a moment to go after the kill returns.
    for (let i = 0; i < 50 && alive(grandchild); i++) await Bun.sleep(100);
    expect(alive(grandchild)).toBe(false);
  }, 30_000);

  test("time asleep is not time worked: a clock jump costs one gap", async () => {
    const clock = join(T, "clock");
    writeFileSync(clock, "0");
    process.env.RALPH_TEST_CLOCK = clock;
    // Jump the clock by 20000s half a second in; the command still has its 5s.
    setTimeout(() => writeFileSync(clock, "20000"), 500);
    const r = await runBounded(5, ["sh", "-c", "sleep 1.5"], { out: join(T, "d.out"), pollGapMax: 2 });
    expect(r).toEqual({ rc: 0, timedOut: false });
  });

  test("names the command in its mark while it runs, and the mark goes when it ends", async () => {
    // The command is bun, not sh: Git's sh on Windows knows itself by an MSYS
    // PID, and the mark holds the one Windows gave it.
    const mark = join(T, "f.mark");
    const seen = join(T, "f.seen");
    const script = join(T, "f.js");
    writeFileSync(
      script,
      `const fs = require("fs"); fs.writeFileSync(process.env.SEEN, process.pid + "|" + fs.readFileSync(process.env.MARK, "utf8"));`,
    );
    const t0 = Math.floor(Date.now() / 1000);
    const r = await runBounded(10, [process.execPath, script], {
      out: join(T, "f.out"),
      env: { ...process.env, MARK: mark, SEEN: seen },
      pollGapMax: 60,
      mark,
    });
    expect(r.rc).toBe(0);
    const [own, pid, started] = readFileSync(seen, "utf8").split(/[| ]/);
    expect(pid).toBe(own);
    expect(Math.abs(Number(started) - t0)).toBeLessThanOrEqual(1);
    expect(existsSync(mark)).toBe(false);
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
    // The leader and its child both ignore TERM, so only the KILL to the group
    // ends either. The child writes its own PID once it runs, and the kill waits
    // for that: a TERM that lands before the trap is set, or a tree still being
    // forked, would test something else.
    const { spawn } = await import("node:child_process");
    const pidFile = join(T, "group-child.pid");
    const script = join(T, "group-child.js");
    writeFileSync(
      script,
      `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000);`,
    );
    const slash = (p: string) => p.split("\\").join("/");
    const c = spawn("sh", ["-c", `trap '' TERM; '${slash(process.execPath)}' '${slash(script)}' & wait`], {
      detached: true,
      stdio: "ignore",
    });
    // The leader is this test's child, a zombie until it is reaped here: ask
    // whether it exited, not whether its PID answers.
    const exited = new Promise<string>((resolve) => c.once("exit", (_code, signal) => resolve(signal ?? "exited")));
    let child = 0;
    let gone = false;
    try {
      for (let i = 0; i < 100 && !child; i++) {
        await Bun.sleep(100);
        try {
          child = Number(readFileSync(pidFile, "utf8").trim());
        } catch {}
      }
      expect(child).toBeGreaterThan(0);
      const t0 = Date.now();
      await killGroup(c.pid!);
      expect(Date.now() - t0).toBeLessThan(12_000);
      const how = await Promise.race([exited, Bun.sleep(5000).then(() => "still running")]);
      // Only a KILL ends a leader that ignores TERM; Windows kills the tree with taskkill.
      expect(how).toBe(process.platform === "win32" ? "exited" : "SIGKILL");
      // The child is the leader's, not this test's, so once the leader is gone
      // init reaps it, and its PID going quiet is the answer.
      for (let i = 0; i < 50 && alive(child); i++) await Bun.sleep(100);
      expect(alive(child)).toBe(false);
      gone = true;
    } finally {
      // A failed check leaves nothing behind for the next test to trip on.
      if (!gone) {
        for (const pid of [-c.pid!, child]) {
          try {
            if (pid) process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    }
  }, 30_000);
});

describe("etime", () => {
  test("prints elapsed seconds the way ps does", () => {
    expect(etime(5)).toBe("00:05");
    expect(etime(3599)).toBe("59:59");
    expect(etime(3600)).toBe("01:00:00");
    expect(etime(2 * 86400 + 3 * 3600 + 4 * 60 + 5)).toBe("2-03:04:05");
  });

  test("reads back what it prints, and nothing else", () => {
    for (const n of [0, 5, 59, 60, 3599, 3600, 86399, 86400, 2 * 86400 + 3 * 3600 + 4 * 60 + 5]) {
      expect(parseEtime(`  ${etime(n)}\n`)).toBe(n);
    }
    for (const bad of ["", "5", "a:b", "1:2:3:4", "-01:02"]) expect(parseEtime(bad)).toBeNull();
  });
});

describe.skipIf(IS_WIN)("reapOrphan", () => {
  const now = () => Math.floor(Date.now() / 1000);

  test("stops the group its mark names when the start matches", async () => {
    const c = spawn("sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
    // This test's child: ask whether it exited, not whether its PID answers.
    const exited = new Promise<string>((resolve) => c.once("exit", (_code, signal) => resolve(signal ?? "exited")));
    const mark = join(T, "g.mark");
    writeFileSync(mark, `${c.pid} ${now()}\n`);
    try {
      expect(await reapOrphan(mark)).toBe(c.pid!);
      expect(await Promise.race([exited, Bun.sleep(5000).then(() => "still running")])).toBe("SIGTERM");
      expect(existsSync(mark)).toBe(false);
    } finally {
      try {
        process.kill(-c.pid!, "SIGKILL");
      } catch {}
    }
  }, 20_000);

  test("leaves a process alone whose start is not the one recorded, and reads no garbage", async () => {
    const c = spawn("sleep", ["30"], { stdio: "ignore" });
    const exited = new Promise<string>((resolve) => c.once("exit", () => resolve("exited")));
    const mark = join(T, "h.mark");
    try {
      writeFileSync(mark, `${c.pid} ${now() - 3600}\n`);
      expect(await reapOrphan(mark)).toBeNull();
      expect(existsSync(mark)).toBe(false);
      for (const bad of [`${c.pid}\n`, `${c.pid} ${now()}`, `x ${now()}\n`, ""]) {
        writeFileSync(mark, bad);
        expect(await reapOrphan(mark)).toBeNull();
      }
      expect(await reapOrphan(join(T, "no-such.mark"))).toBeNull();
      expect(await Promise.race([exited, Bun.sleep(500).then(() => "running")])).toBe("running");
    } finally {
      c.kill("SIGKILL");
    }
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
