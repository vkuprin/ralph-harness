import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import {
  Fx,
  IS_WIN,
  alive,
  join,
  noProc,
  read,
  readConfigValue,
  setup,
  sleeperGone,
  statuses,
  strangers,
  waitProc,
} from "../helpers/index.ts";

const fx = new Fx("meta");
const T = fx.T;

describe("a check is about this run and nothing else", () => {
  // Four checks used to assert about the whole machine: `! pgrep -f "sleep
  // 99[9]"` three times and `! pgrep -f "home-soa[k]"` once. Each is a
  // *negative* assertion, so anything else on the box with that text on its
  // command line turns it red — a sleep a human typed, or a second copy of this
  // suite. This suite is what the harness runs to judge a commit, so that reset
  // work which was fine.
  //
  // The strangers started by the preload have been running throughout, so every
  // process check has been made in their company. These say the strangers were
  // really there, and that the shapes that replaced `pgrep` refuse and accept
  // the right things.
  const app = fx.p("app");
  const loop = fx.p("loops/a");
  const guardPath = fx.p("guard-home-soak");
  let S = "";
  let guard: Bun.Subprocess | undefined;
  let guardUp = false;
  let loopDup: unknown;
  let repoDup: unknown;

  setup(async () => {
    // This file's own timed-out agent: a commit, so the checkout has history
    // for the make_repo check below, then a sleep the timeout has to kill.
    fx.makeRepo(app, fx.p("remote.git"));
    S = fx.stub("stub-a", ["commit", "sleep"]);
    fx.makeLoop(loop, app, { ITER_TIMEOUT: 2, MAX_ITER: 10 });
    await fx.runLoop(loop, S);

    writeFileSync(join(T, "live.pid"), `${strangers().sleep}\n`);
    writeFileSync(join(T, "empty.pid"), "");

    // no_proc matches this run's own directory, literally.
    guard = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1 << 30)", guardPath], {
      env: fx.env(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    guardUp = await waitProc(guard.pid, guardPath);

    // The same claim one scope in: a fixture belongs to one section. Two
    // sections sharing a name has happened twice, and each time the check that
    // went red was hundreds of lines from the edit that caused it.
    try {
      fx.makeLoop(loop, app, { MAX_ITER: 1 });
    } catch (e) {
      loopDup = e;
    }
    // make_repo over a checkout another section owns is the destructive half: it
    // rewrites work.txt, commits, and — since `git remote add origin` fails on a
    // checkout that has one — pushes that to the *first* section's remote.
    try {
      fx.makeRepo(app, fx.p("remote-dup.git"));
    } catch (e) {
      repoDup = e;
    }
    fx.makeLoop(fx.p("loops/dup-ok"), app, { MAX_ITER: 1 });
  });

  afterAll(async () => {
    guard?.kill("SIGKILL");
    await guard?.exited;
  });

  test("the stranger's sleep 999 ran for the whole suite", () => {
    expect(alive(strangers().sleep)).toBe(true);
  });
  test("and so did the stranger whose command line holds home-soak", () => {
    expect(alive(strangers().soak)).toBe(true);
  });
  // Windows has no pgrep; there what matters is that the snapshot noProc reads
  // sees the strangers at all, or every check that nothing is running passes
  // for nothing.
  test.if(IS_WIN)("the process snapshot on Windows sees the strangers", () => {
    expect(noProc("sleep 999")).toBe(false);
    expect(noProc("home-soak")).toBe(false);
  });
  test.skipIf(IS_WIN)("the pattern those four checks used really does match the strangers", () => {
    const pids = (pattern: string) => fx.sh(["pgrep", "-f", pattern]).out.split("\n");
    expect(pids("sleep 99[9]")).toContain(String(strangers().sleep));
    expect(pids("home-soa[k]")).toContain(String(strangers().soak));
  });

  // sleeper_gone asks about the one PID the stub recorded, which is how the
  // timeout checks tell this run's sleeper from the stranger's.
  test("the sleeper the timeout killed reads as gone with a stranger's still running", () => {
    expect(statuses(loop)).toContain("timeout");
    expect(alive(strangers().sleep)).toBe(true);
    expect(sleeperGone(join(S, "sleeper.pid"))).toBe(true);
  });
  test("the stranger's own PID does not read as gone", () => {
    expect(sleeperGone(join(T, "live.pid"))).toBe(false);
  });
  test("and a stub that never recorded one is not a pass either", () => {
    expect(sleeperGone(join(T, "empty.pid"))).toBe(false);
  });

  test("a live process under this run's own directory is found", () => {
    expect(guardUp).toBe(true);
    expect(noProc(guardPath)).toBe(false);
  });
  test("a stranger's home-soak does not answer for this run's", () => {
    expect(noProc(fx.p("home-soak"))).toBe(true);
  });
  test("the directory is matched literally, not as a regex", () => {
    expect(noProc(fx.p("guard-h.me-soak"))).toBe(true);
  });

  // wait_proc waits on a PID, so a stranger holding the text cannot end the wait.
  test("a process this run started is waited for", async () => {
    expect(await waitProc(guard!.pid, guardPath)).toBe(true);
  });
  test("but another process holding that text does not end the wait", async () => {
    expect(await waitProc(strangers().sleep, guardPath)).toBe(false);
  });

  test("make_loop refuses a name another section already used", () => {
    expect(loopDup).toBeInstanceOf(Error);
    expect(String(loopDup)).toContain("fixture reused");
  });
  test("and the loop that name belongs to is untouched", () => {
    expect(readConfigValue(join(loop, "config.json"), "MAX_ITER")).toBe("10");
  });
  test("make_repo refuses one too", () => {
    expect(repoDup).toBeInstanceOf(Error);
    expect(String(repoDup)).toContain("fixture reused");
  });
  test("and made no remote on the way out", () => {
    expect(existsSync(fx.p("remote-dup.git"))).toBe(false);
  });
  test("and the checkout that name belongs to still has its history", () => {
    expect(read(join(app, "work.txt"))).toContain("work 1");
  });
  test("a name no section has used is still made", () => {
    expect(existsSync(fx.p("loops/dup-ok", "config.json"))).toBe(true);
  });
});
