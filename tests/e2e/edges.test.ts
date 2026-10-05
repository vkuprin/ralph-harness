import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import {
  Fx,
  type HookAnswer,
  IS_WIN,
  alive,
  cliPath,
  count,
  events,
  field,
  join,
  lines,
  loopArgv,
  mkNotifier,
  noProc,
  patchConfig,
  read,
  rows,
  setup,
  sleeperGone,
  sq,
  statuses,
  term,
  until,
  waitProc,
} from "../helpers/index.ts";

// Behaviour the bash suite never pinned: settings no section exercised, paths
// through the gates it never took, and the ways a loop is started and stopped.
// Every check here holds for both implementations.

const fx = new Fx("edges");

/** The argument after each occurrence of `flag` in a recorded argv file. */
function after(argvFile: string, flag: string): string[] {
  const a = lines(argvFile);
  const out: string[] = [];
  a.forEach((x, i) => {
    if (x === flag && a[i + 1] !== undefined) out.push(a[i + 1]!);
  });
  return out;
}

describe("ERROR_STOP, and the backoff between failures", () => {
  const app = fx.p("app-es");
  const loop = fx.p("loops/es");
  const loop2 = fx.p("loops/es2");
  const note = fx.p("notify-es.log");
  let took = 0;

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-es.git"));
    mkNotifier(note, fx.p("notify-es.sh"));
    fx.makeLoop(loop, app, { MAX_ITER: 5, ERROR_STOP: 2, NOTIFY_CMD: sq(fx.p("notify-es.sh")) });
    await fx.runLoop(loop, fx.stub("stub-es", ["fail", "fail", "fail"]));
    fx.makeLoop(loop2, app, { MAX_ITER: 3, ERROR_SLEEP: 1 });
    // Timed from the spawn of the process that ran: a loop bun never finished
    // loading is killed and started again after 30s, and that wait is the
    // suite's. Linux CI read 33464ms so, in run 36997718482.
    const run = fx.startLoop(loop2, fx.stub("stub-es2", ["fail", "fail", "nothing"]));
    await run.done;
    took = performance.now() - run.startedAt;
  });

  test("ERROR_STOP stops the loop after that many failures in a row", () => {
    expect(statuses(loop)).toBe("error error");
  });
  test("and says so, in the log and to the human", () => {
    expect(read(join(loop, "ralph.log"))).toContain("stopping: 2 consecutive iterations failed");
    expect(field(5, "stopped", note)).toContain("2 consecutive iterations failed");
  });
  test("the pause after a failure doubles with each one in a row", () => {
    // 1s after the first failure, 2s after the second.
    expect(statuses(loop2)).toBe("error error quiet");
    expect(took).toBeGreaterThanOrEqual(3000);
    expect(took).toBeLessThan(30000);
  });
});

describe("a signal during a nap ends the loop at once", () => {
  const loop = fx.p("loops/nap");
  let code = -1;
  let took = 0;

  setup(async () => {
    const app = fx.p("app-nap");
    fx.makeRepo(app, fx.p("remote-nap.git"));
    fx.makeLoop(loop, app, { MAX_ITER: 5, QUIET_SLEEP: 600 });
    const run = fx.startLoop(loop, fx.stub("stub-nap", ["nothing"]));
    await until(() => read(join(loop, "ralph.log")).includes("shipped nothing"), 30);
    await Bun.sleep(300);
    const t0 = Date.now();
    term(loop, run);
    code = await Promise.race([run.done, Bun.sleep(15000).then(() => -1)]);
    took = Date.now() - t0;
    if (code === -1) run.kill("SIGKILL");
  });

  test("TERM in the middle of a 600s nap ends the loop within seconds", () => {
    expect(code).toBe(130);
    expect(took).toBeLessThan(5000);
  });
  test("it says where it stopped, and lets go of the lock", () => {
    expect(read(join(loop, "ralph.log"))).toContain("ralph stopped by signal during iteration 1");
    expect(existsSync(join(loop, "ralph.lock"))).toBe(false);
  });
});

describe("after the last iteration the loop ends, it does not wait first", () => {
  // Every pause exists to space one iteration from the next, and after
  // MAX_ITER there is no next. The loop used to sleep its backoff, its quiet
  // pause and STEP_SLEEP, and then wait for ACTIVE_HOURS to open again, before
  // it looked at MAX_ITER: up to a day "running" with nothing pending, and
  // PR_MERGE waited behind it. A limit is the exception: the same iteration
  // runs again, so its wait still belongs.
  const hour = fx.p("hour-last");
  const cases: Record<string, { cfg: Record<string, string | number | boolean>; modes: string[]; status: string }> = {
    revert: {
      cfg: { WORKTREE: true, VERIFY_CMD: "false", ERROR_SLEEP: 600, STEP_SLEEP: 600 },
      modes: ["commit"],
      status: "revert:verify",
    },
    keep: { cfg: { STEP_SLEEP: 600 }, modes: ["commit"], status: "keep" },
    quiet: { cfg: { QUIET_SLEEP: 600, STEP_SLEEP: 600 }, modes: ["nothing"], status: "quiet" },
    error: { cfg: { ERROR_SLEEP: 600, STEP_SLEEP: 600 }, modes: ["fail"], status: "error" },
    // The window closes during the last iteration's gate.
    hours: {
      cfg: { WORKTREE: true, ACTIVE_HOURS: "22-08", ACTIVE_POLL: 1, VERIFY_CMD: `printf '09\\n' > ${sq(hour)}` },
      modes: ["commit"],
      status: "keep",
    },
    limit: { cfg: { RATE_LIMIT_SLEEP: 2 }, modes: ["limit", "commit"], status: "ratelimit keep" },
  };
  const ended: Record<string, number | "timeout"> = {};
  const took: Record<string, number> = {};

  setup(async () => {
    writeFileSync(hour, "23\n");
    await Promise.all(
      Object.entries(cases).map(async ([name, c]) => {
        const app = fx.p(`app-last-${name}`);
        fx.makeRepo(app, fx.p(`remote-last-${name}.git`));
        fx.makeLoop(fx.p(`loops/last-${name}`), app, { MAX_ITER: 1, ...c.cfg });
        const t0 = Date.now();
        const run = fx.startLoop(fx.p(`loops/last-${name}`), fx.stub(`stub-last-${name}`, c.modes), {
          env: { RALPH_TEST_HOUR: hour },
        });
        ended[name] = await Promise.race([run.done, Bun.sleep(60_000).then(() => "timeout" as const)]);
        took[name] = Date.now() - t0;
        if (ended[name] === "timeout") {
          run.kill("SIGKILL");
          await run.done;
        }
      }),
    );
  });

  for (const [name, c] of Object.entries(cases)) {
    test(`${name}: the loop ends at MAX_ITER without the pause`, () => {
      const loop = fx.p(`loops/last-${name}`);
      expect(statuses(loop)).toBe(c.status);
      expect(ended[name]).toBe(0);
      expect(read(join(loop, "ralph.log"))).toContain("stopping: hit MAX_ITER=1");
    });
  }
  test("a window that closed during the last iteration is not waited for", () => {
    expect(read(fx.p("loops/last-hours", "ralph.log"))).not.toContain("outside ACTIVE_HOURS");
  });
  test("a limit on the last iteration is still waited out, and the iteration run again", () => {
    expect(took.limit).toBeGreaterThanOrEqual(2000);
    expect(read(fx.p("stub-last-limit", "agent_calls")).trim()).toBe("2");
  });
});

describe("a BRANCH other than main", () => {
  const app = fx.p("app-br");
  const remote = fx.p("remote-br.git");
  const loop = fx.p("loops/br");

  setup(async () => {
    fx.makeRepo(app, remote);
    fx.git(app, "checkout", "-q", "-b", "dev");
    writeFileSync(join(app, "dev.txt"), "dev\n");
    fx.git(app, "add", "dev.txt");
    fx.git(app, "commit", "-qm", "dev: start");
    fx.git(app, "push", "-q", "-u", "origin", "dev");
    fx.git(app, "checkout", "-q", "main");
    fx.makeLoop(loop, app, { WORKTREE: true, PUSH: true, PUSH_CONFIRM: "dev", BRANCH: "dev", MAX_ITER: 1 });
    await fx.runLoop(loop, fx.stub("stub-br", ["commit"]), { remote });
  });

  test("the worktree starts from origin/BRANCH", () => {
    expect(existsSync(fx.p("app-br-ralph-br", "dev.txt"))).toBe(true);
  });
  test("and kept commits are pushed to BRANCH, not to main", () => {
    expect(statuses(loop)).toBe("keep");
    expect(fx.git(remote, "log", "--format=%s", "dev")).toContain("stub: work");
    expect(fx.git(remote, "log", "--format=%s", "main")).not.toContain("stub:");
  });
});

describe("what the agent is started with", () => {
  const app = fx.p("app-argv");
  const loop = fx.p("loops/argv");
  const loop2 = fx.p("loops/argv2");
  let S = "";
  let S2 = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-argv.git"));
    S = fx.stub("stub-argv", ["nothing"]);
    fx.makeLoop(loop, app, {
      MAX_ITER: 1,
      MODEL: "model-for-the-agent",
      ADD_DIRS: [fx.p("extra one"), fx.p("extra-two")],
      CLOSING: "Close with this exact sentence.",
    });
    await fx.runLoop(loop, S);
    S2 = fx.stub("stub-argv2", ["nothing"]);
    fx.makeLoop(loop2, app, { MAX_ITER: 1, LIVE_STEER: false });
    await fx.runLoop(loop2, S2);
  });

  test("MODEL reaches the agent", () => {
    expect(after(join(S, "argv.agent.1"), "--model")).toEqual(["model-for-the-agent"]);
  });
  test("the loop directory and every ADD_DIRS entry are --add-dir, in order", () => {
    expect(after(join(S, "argv.agent.1"), "--add-dir")).toEqual([loop, fx.p("extra one"), fx.p("extra-two")]);
  });
  test("CLOSING is the last thing in the prompt", () => {
    expect(read(join(S, "prompt.agent.1")).endsWith("\n---\n\nClose with this exact sentence.\n")).toBe(true);
  });
  test("with LIVE_STEER the agent gets a settings file that registers the steer hook", () => {
    expect(after(join(S, "argv.agent.1"), "--settings")).toEqual([join(loop, ".agent-settings.json")]);
    const s = JSON.parse(read(join(loop, ".agent-settings.json"))) as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
    };
    expect(s.hooks.PreToolUse[0]?.matcher).toBe("*");
    expect(s.hooks.PreToolUse[0]?.hooks[0]?.command).toContain("hooks/steer");
  });
  test("without LIVE_STEER there is no settings file and no --settings", () => {
    expect(lines(join(S2, "argv.agent.1"))).not.toContain("--settings");
    expect(existsSync(join(loop2, ".agent-settings.json"))).toBe(false);
  });
});

describe("the steer hook, end to end", () => {
  const app = fx.p("app-hook");
  const loop = fx.p("loops/hook");
  let S = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-hook.git"));
    S = fx.stub("stub-hook", ["run-hook"], ["ACCEPT"]);
    writeFileSync(join(S, "steer-text"), "focus on the login flow\n");
    fx.makeLoop(loop, app, { WORKTREE: true, REVIEW: true, MAX_ITER: 1 });
    await fx.runLoop(loop, S);
  });

  test("a steer sent mid-iteration blocks the agent's next tool call, with the steer as the reason", () => {
    const j = JSON.parse(read(join(S, "hook.1"))) as HookAnswer;
    const blocked = j.decision === "block" || j.hookSpecificOutput?.permissionDecision === "deny";
    const reason = j.reason ?? j.hookSpecificOutput?.permissionDecisionReason;
    expect(blocked).toBe(true);
    expect(reason).toContain("focus on the login flow");
  });
  test("it is delivered once: STEER.md is empty after", () => {
    expect(read(join(loop, "STEER.md"))).toBe("");
  });
  test("and the reviewer judges the commit against it", () => {
    const p = read(join(S, "prompt.review.1"));
    expect(p.slice(p.indexOf("## Steering from the human"))).toContain("focus on the login flow");
    expect(statuses(loop)).toBe("keep");
  });
});

describe("the checks the human owns run out of time", () => {
  const app = fx.p("app-to");
  const loopV = fx.p("loops/to-verify");
  const loopH = fx.p("loops/to-health");
  let SH = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-to.git"));
    fx.makeLoop(loopV, app, {
      WORKTREE: true,
      MAX_ITER: 1,
      VERIFY_TIMEOUT: 1,
      VERIFY_CMD: `sleep 30 & echo $! > '${fx.p("verify.pid")}'; wait`,
    });
    await fx.runLoop(loopV, fx.stub("stub-to-v", ["commit"]));
    SH = fx.stub("stub-to-h", ["nothing"]);
    fx.makeLoop(loopH, app, {
      MAX_ITER: 1,
      HEALTH_TIMEOUT: 1,
      HEALTH_CMD: `sleep 30 & echo $! > '${fx.p("health.pid")}'; wait`,
    });
    await fx.runLoop(loopH, SH);
  });

  test("a VERIFY_CMD past VERIFY_TIMEOUT fails the commit, and says so", () => {
    expect(statuses(loopV)).toBe("revert:verify");
    expect(rows(loopV)[0]![6]).toBe("verify timed out after 1s");
  });
  test("and its process group is killed", () => {
    expect(sleeperGone(fx.p("verify.pid"))).toBe(true);
  });
  test("a HEALTH_CMD past HEALTH_TIMEOUT counts as failing, and leads the prompt", () => {
    expect(read(join(loopH, "ralph.log"))).toContain("health: HEALTH_CMD timed out after 1s");
    expect(read(join(SH, "prompt.agent.1"))).toContain("timed out after 1s");
  });
  test("and its process group is killed too", () => {
    expect(sleeperGone(fx.p("health.pid"))).toBe(true);
  });
});

describe("a reviewer that crashes or says nothing", () => {
  const app = fx.p("app-rv");
  const crash = fx.p("loops/rv-crash");
  const silent = fx.p("loops/rv-silent");

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-rv.git"));
    fx.makeLoop(crash, app, { WORKTREE: true, REVIEW: true, MAX_ITER: 1, VERIFY_CMD: "./measure.sh" });
    await fx.runLoop(crash, fx.stub("stub-rv-crash", ["commit"], ["CRASH"]));
    fx.makeLoop(silent, app, { WORKTREE: true, REVIEW: true, MAX_ITER: 1, WORKTREE_DIR: fx.p("wt-rv-silent") });
    await fx.runLoop(silent, fx.stub("stub-rv-silent", ["commit"], ["SILENT"]));
  });

  test("a reviewer that crashes is unavailable: VERIFY_CMD passed, so the commit ships marked unreviewed", () => {
    expect(statuses(crash)).toBe("keep:unreviewed");
    expect(rows(crash)[0]![6]).toBe("reviewer gave no verdict (exit 1, timed out 0); VERIFY_CMD passed");
  });
  test("a reviewer with no VERDICT line, and no VERIFY_CMD, ships nothing", () => {
    expect(statuses(silent)).toBe("revert:review-unavailable");
    expect(rows(silent)[0]![6]).toBe("reviewer gave no verdict (exit 0, timed out 0)");
  });
});

describe("a rebase that fails verify is dropped (PUSH=1)", () => {
  const app = fx.p("app-rev");
  const remote = fx.p("remote-rev.git");
  const loop = fx.p("loops/rev");

  setup(async () => {
    fx.makeRepo(app, remote);
    // The human's push adds human.txt, which this VERIFY_CMD refuses: the
    // commit passes on its own and fails once rebased onto the human's work.
    fx.makeLoop(loop, app, { WORKTREE: true, PUSH: true, PUSH_CONFIRM: "main", MAX_ITER: 1, VERIFY_CMD: "test ! -f human.txt" });
    await fx.runLoop(loop, fx.stub("stub-rev", ["human-main"]), { remote });
  });

  test("kept, then dropped when the rebased commit fails verify", () => {
    expect(statuses(loop)).toBe("keep drop:reverify");
    expect(rows(loop)[1]![6]).toContain("after rebase onto origin/main: verify exited 1");
  });
  test("so it never reaches origin, and is kept under refs/ralph/rev/dropped/", () => {
    const main = fx.git(remote, "log", "--format=%s", "main");
    expect(main).toContain("human: add human.txt");
    expect(main).not.toContain("stub: work");
    expect(fx.git(fx.p("app-rev-ralph-rev"), "for-each-ref", "refs/ralph/rev/dropped/")).not.toBe("");
  });
});

describe("a fetch that never answers is cut off, as a push is", () => {
  // A stalled connection does not fail a fetch by itself, and every fetch ran
  // unbounded: the loop sat in sync for good, saying nothing. Origin here is a
  // transport that hangs, and it moves the fake clock 1000 awake seconds on
  // its way in, so the 300s bound is reached on the next poll.
  const ran: Record<string, { code: number | "timeout"; took: number }> = {};

  async function runHung(name: string, cfg: Record<string, unknown>): Promise<void> {
    const app = fx.p(`app-${name}`);
    fx.makeRepo(app, fx.p(`remote-${name}.git`));
    // The clock file comes through the environment, so no path is read by
    // the shell, and names the hanging command on its command line.
    const hang = `sh -c 'n=$(cat "$RALPH_TEST_CLOCK"); echo $((n+1000)) > "$RALPH_TEST_CLOCK"; exec sh -c "sleep 611; :" "$RALPH_TEST_CLOCK"' --`;
    fx.git(app, "config", "core.sshCommand", hang);
    fx.git(app, "remote", "set-url", "origin", "ssh://hang.invalid/x");
    const clock = fx.p(`clock-${name}`);
    writeFileSync(clock, "0\n");
    fx.makeLoop(fx.p(`loops/${name}`), app, { WORKTREE: true, MAX_ITER: 1, POLL_GAP_MAX: 100000, ...cfg });
    const run = fx.startLoop(fx.p(`loops/${name}`), fx.stub(`stub-${name}`, ["commit"]), { env: { RALPH_TEST_CLOCK: clock } });
    const t0 = Date.now();
    const code = await Promise.race([run.done, Bun.sleep(60_000).then(() => "timeout" as const)]);
    ran[name] = { code, took: (Date.now() - t0) / 1000 };
    if (code === "timeout") {
      run.kill();
      await run.done;
    }
  }

  setup(async () => {
    await runHung("hangpush", { PUSH: true, PUSH_CONFIRM: "main" });
    await runHung("hangpr", { PUSH: "pr" });
  });

  test("the loop ends by itself, in well under the 611s the fetch would hang", () => {
    for (const name of ["hangpush", "hangpr"]) {
      expect(ran[name]!.code).toBe(0);
      expect(ran[name]!.took).toBeLessThan(60);
    }
  });
  test("the commit is still kept, and stays local", () => {
    expect(statuses(fx.p("loops/hangpush"))).toBe("keep");
    expect(fx.git(fx.p("remote-hangpush.git"), "log", "--format=%s", "main")).not.toContain("stub: work");
    expect(statuses(fx.p("loops/hangpr"))).toBe("keep");
    expect(fx.gitOk(fx.p("remote-hangpr.git"), "rev-parse", "-q", "--verify", "refs/heads/ralph/hangpr")).toBe(false);
  });
  test("each fetch says it timed out: at the worktree's creation, and in both syncs", () => {
    for (const name of ["hangpush", "hangpr"]) {
      const log = read(join(fx.p(`loops/${name}`), "ralph.log"));
      expect(count(log, /git fetch origin main timed out after 300s/)).toBe(3);
      expect(count(log, /sync: fetch failed, not pushing this time/)).toBe(2);
    }
  });
  test("and the transport it was waiting on is gone", async () => {
    expect(await until(() => noProc(fx.p("clock-hangpush")) && noProc(fx.p("clock-hangpr")), 5)).toBe(true);
  });
});

describe("SETUP_CMD that works, and a branch that is reused", () => {
  const app = fx.p("app-set");
  const loop = fx.p("loops/set");
  const W = fx.p("app-set-ralph-set");
  const ran = fx.p("setup-ran");
  let afterFirst = 0;
  let afterSecond = 0;
  let branchBefore = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-set.git"));
    fx.makeLoop(loop, app, { WORKTREE: true, MAX_ITER: 1, SETUP_CMD: `echo ran >> '${ran}'` });
    await fx.runLoop(loop, fx.stub("stub-set", ["commit"]));
    afterFirst = lines(ran).length;
    await fx.runLoop(loop, fx.stub("stub-set2", ["nothing"]));
    afterSecond = lines(ran).length;
    branchBefore = fx.git(app, "rev-parse", "ralph/set");
    fx.git(app, "worktree", "remove", "--force", W);
    await fx.runLoop(loop, fx.stub("stub-set3", ["nothing"]));
  });

  test("SETUP_CMD runs once, in the new worktree, and the loop goes on", () => {
    expect(afterFirst).toBe(1);
    expect(read(join(loop, "ralph.log"))).toContain(`setup: echo ran >> '${ran}'`);
    expect(statuses(loop).split(" ")[0]).toBe("keep");
  });
  test("a restart with the worktree in place does not run it again", () => {
    expect(afterSecond).toBe(1);
  });
  test("a worktree gone with its branch kept is rebuilt on that branch, kept work and all", () => {
    expect(existsSync(W)).toBe(true);
    expect(fx.git(W, "rev-parse", "HEAD")).toBe(branchBefore);
    expect(fx.git(W, "log", "--format=%s")).toContain("stub: work");
  });
  test("and setup is not run over it", () => {
    expect(lines(ran).length).toBe(1);
  });
});

describe("a start stopped while SETUP_CMD runs", () => {
  // `ralph stop` during a slow setup, an `npm ci` under bash. Measured before
  // the fix: the TERM reached the shell alone, so what the setup had started
  // ran on in the worktree with no loop above it, and the next start found the
  // worktree and its branch in place, took the reuse path, which never runs
  // SETUP_CMD, and ran the agent in a checkout its setup had never finished.
  const app = fx.p("app-setstop");
  const loop = fx.p("loops/setstop");
  const hold = fx.p("setstop-hold");
  const first = fx.p("setstop-first");
  const ran = fx.p("setstop-ran");
  let code = -1;
  let held = false;
  let gone = false;
  let S2 = "";
  let afterThird = 0;

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-setstop.git"));
    // The first setup waits on a child of its own, as bash waits on npm; every
    // later one finishes at once. `hold` names that child on its command line.
    const script = fx.p("setstop.sh");
    writeFileSync(
      script,
      `if [ -e ${sq(first)} ]; then echo ran >> ${sq(ran)}; exit 0; fi\nbash -c 'sleep 30; :' ${sq(hold)} &\n: > ${sq(first)}\nwait\n`,
    );
    fx.makeLoop(loop, app, { WORKTREE: true, MAX_ITER: 1, QUIET_SLEEP: 1, SETUP_CMD: `bash ${sq(script)}` });
    const run = fx.startLoop(loop, fx.stub("stub-setstop", ["nothing"]));
    held = await until(() => existsSync(first), 30);
    term(loop, run);
    code = await run.done;
    gone = await until(() => noProc(hold), 5);
    S2 = fx.stub("stub-setstop2", ["nothing"]);
    await fx.runLoop(loop, S2);
    await fx.runLoop(loop, fx.stub("stub-setstop3", ["nothing"]));
    afterThird = lines(ran).length;
  });

  test("the stop ends what the setup started, not only its shell", () => {
    expect(held).toBe(true);
    expect(code).toBe(130);
    expect(gone).toBe(true);
  });
  test("the next start runs SETUP_CMD again, before the agent", () => {
    const log = read(join(loop, "ralph.log"));
    expect(count(log, /setup: bash /)).toBe(2);
    expect(log).toContain("SETUP_CMD did not finish the last time");
    expect(read(join(S2, "agent_calls")).trim()).toBe("1");
  });
  test("and once it has finished, a start does not run it again", () => {
    expect(afterThird).toBe(1);
  });
});

describe("how the loop is started", () => {
  const app = fx.p("app-arg");
  const loop = fx.p("loops/arg");
  let viaEnv = { code: -1, out: "" };
  let none = { code: -1, err: "" };
  let missing = { code: -1, err: "" };

  setup(() => {
    fx.makeRepo(app, fx.p("remote-arg.git"));
    fx.makeLoop(loop, app, { MAX_ITER: 1 });
    const S = fx.stub("stub-arg", ["nothing"]);
    const r = fx.sh(loopArgv(), { env: { RALPH_LOOP: loop, STUB_DIR: S } });
    viaEnv = { code: r.code, out: r.out };
    const n = fx.sh(loopArgv());
    none = { code: n.code, err: n.err };
    const m = fx.sh(loopArgv(fx.p("no-such-loop")));
    missing = { code: m.code, err: m.err };
  });

  test("RALPH_LOOP names the loop when no argument does", () => {
    expect(viaEnv.code).toBe(0);
    expect(statuses(loop)).toBe("quiet");
  });
  test("with neither, it prints its usage and exits 2", () => {
    expect(none.code).toBe(2);
    expect(none.err).toContain("usage");
  });
  test("a directory that is not there exits 2 and says so", () => {
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("no such loop directory");
  });
});

describe("state that outlives a restart", () => {
  const app = fx.p("app-rs");
  const health = fx.p("loops/rs-health");
  const churn = fx.p("loops/rs-churn");
  const pr = fx.p("loops/rs-pr");
  const remotePr = fx.p("remote-rs-pr.git");
  const churnNote = fx.p("notify-rs-churn.log");
  const prNote = fx.p("notify-rs-pr.log");
  let SH2 = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-rs.git"));
    const SH = fx.stub("stub-rs-h", ["sicken"]);
    fx.makeLoop(health, app, {
      WORKTREE: true,
      MAX_ITER: 1,
      HEALTH_CMD: `test ! -f '${join(SH, "sick")}'`,
    });
    await fx.runLoop(health, SH);
    // The same stub directory, so the sick file the first run left is seen.
    SH2 = SH;
    writeFileSync(join(SH, "modes"), "nothing\n");
    await fx.runLoop(health, SH);

    mkNotifier(churnNote, fx.p("notify-rs-churn.sh"));
    fx.makeLoop(churn, app, {
      WORKTREE: true,
      MAX_ITER: 3,
      CHURN_AT: 2,
      NOTIFY_CMD: sq(fx.p("notify-rs-churn.sh")),
      WORKTREE_DIR: fx.p("wt-rs-churn"),
    });
    await fx.runLoop(churn, fx.stub("stub-rs-c", ["commit", "commit", "commit"]));
    await fx.runLoop(churn, fx.stub("stub-rs-c2", ["commit"]));

    const appPr = fx.p("app-rs-pr");
    fx.makeRepo(appPr, remotePr);
    mkNotifier(prNote, fx.p("notify-rs-pr.sh"));
    fx.makeLoop(pr, appPr, { WORKTREE: true, PUSH: "pr", MAX_ITER: 1, NOTIFY_CMD: sq(fx.p("notify-rs-pr.sh")) });
    await fx.runLoop(pr, fx.stub("stub-rs-p", ["commit"]), { remote: remotePr });
    await fx.runLoop(pr, fx.stub("stub-rs-p2", ["commit"]), { remote: remotePr });
  });

  test("the last HEAD that passed HEALTH_CMD survives a restart, so the suspects are still named", () => {
    const p = read(join(SH2, "prompt.agent.2"));
    expect(p).toContain("health check is failing");
    expect(p).toContain("stub: sicken");
  });
  test("a churning file the human heard about is not news again after a restart", () => {
    // Red once in a full local run and never in 88 runs of its own, with
    // nothing to say why. The loop's own record of the two runs is the why.
    const why = ["results.tsv", ".churn-seen", "ralph.log"].map((f) => `--- ${f}\n${read(join(churn, f))}`).join("\n");
    expect(
      events(churnNote).filter((e: string) => e === "churn"),
      why,
    ).toEqual(["churn"]);
  });
  test("what the harness pushed itself is remembered, so a restart pushes on top of it", () => {
    expect(statuses(pr)).toBe("keep keep");
    expect(fx.git(remotePr, "rev-parse", "ralph/rs-pr")).toBe(fx.git(fx.p("app-rs-pr-ralph-rs-pr"), "rev-parse", "HEAD"));
    expect(events(prNote)).not.toContain("pr-blocked");
  });
});

// A loop killed with no chance to run its handler (kill -9, the OOM killer,
// bun crashing) left its agent running in a group of its own: `ralph status`
// called the loop stopped, `ralph stop` found nothing to stop, and the next
// start ran a second agent beside it in the same checkout. Windows reaps
// nothing yet (see reapOrphan).
describe.skipIf(IS_WIN)("a loop killed without its handler: the next start stops what it left running", () => {
  const app = fx.p("app-k9");
  const loop = fx.p("loops/k9");
  const odd = fx.p("loops/k9-odd");
  let S = "";
  let agent = 0;
  let outlived = false;
  let stranger: Bun.Subprocess | null = null;
  let strangerRunning = false;

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-k9.git"));
    fx.makeLoop(loop, app, { WORKTREE: true, MAX_ITER: 1, VERIFY_CMD: "./measure.sh" });
    S = fx.stub("stub-k9", ["sleep", "commit"]);
    const first = fx.startLoop(loop, S);
    await until(() => read(join(S, "sleeper.pid")).trim() !== "", 30);
    agent = Number(fx.sh(["ps", "-o", "ppid=", "-p", read(join(S, "sleeper.pid")).trim()]).out.trim());
    first.kill("SIGKILL");
    await first.done;
    outlived = !sleeperGone(join(S, "sleeper.pid"));
    await fx.runLoop(loop, S);

    // A mark naming a PID that is now somebody else's: a process this test
    // started, whose start is not the one recorded.
    fx.makeLoop(odd, app, { MAX_ITER: 1 });
    stranger = Bun.spawn(["sleep", "999"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(odd, ".child"), `${stranger.pid} 1000000000\n`);
    await fx.runLoop(odd, fx.stub("stub-k9-odd", ["nothing"]));
    await Bun.sleep(200);
    strangerRunning = stranger.exitCode === null && stranger.signalCode === null;
    stranger.kill("SIGKILL");
  });
  afterAll(() => {
    // Against a loop that reaps nothing the agent is still running, and a
    // failed check leaves nothing behind for the next test to trip on.
    if (agent > 1 && !noProc(`--add-dir ${loop} `)) {
      try {
        process.kill(-agent, "SIGKILL");
      } catch {}
    }
  });

  test("the agent outlived the loop that started it", () => {
    expect(agent).toBeGreaterThan(1);
    expect(outlived).toBe(true);
  });
  test("the next start stopped it and its whole group", () => {
    expect(sleeperGone(join(S, "sleeper.pid"))).toBe(true);
    expect(noProc(`--add-dir ${loop} `)).toBe(true);
  });
  test("and said so, before its own iteration began", () => {
    const log = read(join(loop, "ralph.log"));
    const said = log.indexOf(`start: PID ${agent}, which the last run of this loop left running`);
    expect(said).toBeGreaterThan(-1);
    expect(log.indexOf("=== iteration", said)).toBeGreaterThan(said);
    expect(count(log, /was still running; stopped it/)).toBe(1);
  });
  test("the restarted iteration was judged, and leaves no mark behind", () => {
    expect(read(join(S, "agent_calls")).trim()).toBe("2");
    expect(statuses(loop)).toBe("keep");
    expect(existsSync(join(loop, ".child"))).toBe(false);
  });
  test("a mark whose PID is now somebody else's kills nothing", () => {
    expect(strangerRunning).toBe(true);
    expect(read(join(odd, "ralph.log"))).not.toContain("stopped it and its process group");
    expect(existsSync(join(odd, ".child"))).toBe(false);
  });
});

describe("a start refused before the lock leaves the running loop's mark alone", () => {
  // The loop judges its settings before it takes ralph.lock, so a second start
  // can refuse while the first runs, and a refusal notifies. Its notifier is a
  // bounded command, which marks .child, and the mark there is the running
  // loop's agent: the one its next start stops if this loop is killed outright.
  const app = fx.p("app-premark");
  const loop = fx.p("loops/premark");
  const notes = fx.p("premark-notify.log");
  let S = "";
  let before = "";
  let after = "";
  let second = -1;
  let gone = false;

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-premark.git"));
    const notifier = fx.p("premark-notify.sh");
    mkNotifier(notes, notifier);
    fx.makeLoop(loop, app, { MAX_ITER: 1, ITER_TIMEOUT: 600, NOTIFY_CMD: sq(notifier) });
    S = fx.stub("stub-premark", ["sleep"]);
    const first = fx.startLoop(loop, S);
    try {
      await until(() => read(join(S, "sleeper.pid")).trim() !== "", 30);
      before = read(join(loop, ".child"));
      // A setting the running loop never read (config.json is read once), and
      // one the second start refuses after reading it.
      patchConfig(loop, { PR_MERGE: true });
      second = await fx.runLoop(loop, S);
      after = read(join(loop, ".child"));
    } finally {
      term(loop, first);
      await first.done;
      gone = sleeperGone(join(S, "sleeper.pid"));
    }
  });

  test("the second start was refused, and said so through the notifier", () => {
    expect(second).toBe(2);
    expect(events(notes)).toContain("refused");
  });
  test("the mark still names the running loop's agent", () => {
    expect(before).toMatch(/^\d+ \d+\n$/);
    expect(after).toBe(before);
  });
  test("and the running loop, stopped, takes its agent with it", () => {
    expect(gone).toBe(true);
  });
});

describe("CLI edges", () => {
  const home = fx.p("home-edge");
  const app = fx.p("app-edge");
  const busy = join(home, "busy");
  const shipped = join(home, "shipped");
  let again = { code: -1, out: "", err: "" };
  let stopped = { code: -1, out: "", err: "" };
  let stuckGone = false;
  let stopTook = 0;

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-edge.git"));
    const S = fx.stub("stub-edge", ["sleep"]);
    fx.makeLoop(busy, app, { MAX_ITER: 1, ITER_TIMEOUT: 600 });
    fx.cli(home, ["start", "busy"], { STUB_DIR: S });
    await until(() => existsSync(join(S, "sleeper.pid")), 20);
    again = fx.cli(home, ["start", "busy"], { STUB_DIR: S });
    fx.cli(home, ["stop", "busy"]);

    fx.makeLoop(shipped, app, { MAX_ITER: 3, WORKTREE: true });
    await fx.runLoop(shipped, fx.stub("stub-edge2", ["commit", "commit", "commit"]));

    // A loop that will not go on TERM: a process whose command line is the
    // loop's, and which ignores the signal. `ralph stop` has to reach for KILL.
    const stubborn = join(home, "stubborn");
    fx.makeLoop(stubborn, app, { MAX_ITER: 1 });
    const mark = join(fx.T, "src/loop/main.ts");
    const p = Bun.spawn(["bash", "-c", "trap '' TERM; while :; do sleep 0.2; done", mark, stubborn], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitProc(p.pid, stubborn);
    writeFileSync(join(stubborn, "ralph.pid"), `${p.pid}\n`);
    const t0 = Date.now();
    stopped = fx.cli(home, ["stop", "stubborn"]);
    stopTook = Date.now() - t0;
    // It is this test's child, so it stays a zombie until reaped here: ask
    // whether it exited, not whether its PID answers.
    stuckGone = await Promise.race([p.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!stuckGone) p.kill("SIGKILL");
  });

  test("starting a loop that is already running is refused", () => {
    expect(again.code).not.toBe(0);
    expect(again.err).toContain("already running");
  });
  test("stop reaches for KILL when a loop will not go on TERM", () => {
    expect(stopped.code).toBe(0);
    expect(stuckGone).toBe(true);
    expect(stopTook).toBeGreaterThanOrEqual(14000);
  });
  test("steer with no text prints its usage", () => {
    const r = fx.cli(home, ["steer", "busy"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("usage: ralph steer");
  });
  test("an unknown command says so", () => {
    const r = fx.cli(home, ["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown command: frobnicate");
  });
  test("results N shows the header and the last N rows", () => {
    const r = fx.cli(home, ["results", "shipped", "2"]);
    expect(r.out.trimEnd().split("\n").length).toBe(3);
    expect(r.out.split("\n")[0]).toContain("status");
  });
  test("review N lists at most N shipped commits", () => {
    const r = fx.cli(home, ["review", "shipped", "1"]).out;
    const shippedSection = r.slice(r.indexOf("Shipped, newest first"), r.indexOf("Reverted or dropped"));
    expect(count(shippedSection, /stub: work/)).toBe(1);
    expect(shippedSection).toContain("agent call 3");
  });
  test("log N shows the last N lines", () => {
    const r = fx.cli(home, ["log", "shipped", "2"]);
    expect(r.code).toBe(0);
    expect(r.out.trimEnd().split("\n").length).toBe(2);
  });
  // parseInt read `-1` (tail's habit) as -1, so log and results printed nothing
  // and review said "nothing yet" over three shipped commits; `1e3` as 1; `0`,
  // `abc` and an empty word as the default. All with exit 0.
  test("an n that is not a whole number of 1 or more is refused, not guessed at", () => {
    for (const cmd of ["log", "results", "review"])
      for (const n of ["-1", "0", "abc", "1e3", "2x", "+2", " 2", ""]) {
        const r = fx.cli(home, [cmd, "shipped", n]);
        expect({ cmd, n, code: r.code, out: r.out }).toEqual({ cmd, n, code: 1, out: "" });
        expect(r.err).toContain(`usage: ralph ${cmd} <name> [n]`);
      }
  });
});

describe("a loop stopped while the gates judge a commit judges it at its next start", () => {
  // The agent had finished and been paid for; VERIFY_CMD was running when the
  // loop stopped. A start used to set such a commit aside as never judged, and
  // the whole iteration was paid for again. On POSIX the stop is a TERM nobody
  // asked for, sent by VERIFY_CMD itself, which is also a loop that died.
  // Windows has no TERM to send, so there VERIFY_CMD asks through the stop file.
  const app = fx.p("app-resume");
  const R = fx.p("remote-resume.git");
  const loop = fx.p("loops/resume");
  const notes = fx.p("notify-resume.log");
  const flag = fx.p("resume.flag");
  let first = -1;
  let second = -1;
  let pending = false;
  let rowsAtStop: string[][] = [];

  setup(async () => {
    fx.makeRepo(app, R);
    const S = fx.stub("stub-resume", ["commit"]);
    mkNotifier(notes, fx.p("notify-resume.sh"));
    const stopIt = IS_WIN ? `touch ${sq(join(loop, "ralph.stop"))}` : 'kill -TERM "$PPID"';
    fx.makeLoop(loop, app, {
      WORKTREE: true,
      PUSH: true,
      PUSH_CONFIRM: "main",
      MAX_ITER: 1,
      VERIFY_CMD: `if [ ! -f ${sq(flag)} ]; then touch ${sq(flag)}; ${stopIt}; sleep 30; fi; ./measure.sh`,
      NOTIFY_CMD: sq(fx.p("notify-resume.sh")),
    });
    first = await fx.runLoop(loop, S, { remote: R });
    pending = existsSync(join(loop, ".judging"));
    rowsAtStop = rows(loop);
    second = await fx.runLoop(loop, S, { remote: R });
  });

  test("the first run stopped in VERIFY_CMD, before any verdict", () => {
    expect(first).toBe(130);
    expect(rowsAtStop).toEqual([]);
    expect(pending).toBe(true);
    expect(read(join(loop, "ralph.log"))).toContain(`ralph stopped by signal during iteration 1 (${IS_WIN ? "ralph stop" : "SIGTERM"})`);
  });
  test.skipIf(IS_WIN)("a signal ralph stop did not send is reported as died", () => {
    const died = lines(notes).filter((l) => l.startsWith("died\t"));
    expect(died.length).toBe(1);
    expect(died[0]).toContain("the loop was ended by SIGTERM, not by ralph stop, during iteration 1");
    expect(died[0]).toContain("ralph start resume");
  });
  test("the next start judged the commit instead of setting it aside", () => {
    expect(second).toBe(0);
    expect(statuses(loop)).toBe("keep quiet");
    const [row] = rows(loop);
    expect(row?.[1]).toBe("1");
    expect(row?.[6]).toBe("judged at restart");
    expect(read(join(loop, "ralph.log"))).toContain("its agent had finished, so it is judged now");
    expect(read(join(loop, "results.tsv"))).not.toContain("drop:interrupted");
    expect(existsSync(join(loop, ".judging"))).toBe(false);
  });
  test("and it shipped, as a commit the gates passed does", () => {
    expect(fx.git(R, "log", "--format=%s", "main")).toContain("stub: work (agent call 1)");
    expect(count(read(join(loop, "ralph.log")), /shipped [0-9a-f]{40}/g)).toBe(1);
  });
});

describe("ralph stop is the human's own stop: no died", () => {
  const home = fx.p("asked-home");
  const loop = join(home, "asked");
  const notes = fx.p("notify-asked.log");
  let napping = false;
  let gone = false;

  setup(async () => {
    fx.makeRepo(fx.p("app-asked"), fx.p("remote-asked.git"));
    const S = fx.stub("stub-asked", ["sleep"]);
    mkNotifier(notes, fx.p("notify-asked.sh"));
    fx.makeLoop(loop, fx.p("app-asked"), { MAX_ITER: 1, NOTIFY_CMD: sq(fx.p("notify-asked.sh")) });
    fx.cli(home, ["start", "asked"], { STUB_DIR: S });
    napping = await until(() => existsSync(join(S, "sleeper.pid")), 60);
    fx.cli(home, ["stop", "asked"]);
    gone = await until(() => read(join(loop, "ralph.log")).includes("ralph stopped by signal"), 30);
  });

  test("the loop says it was ralph stop, and nobody is told it died", () => {
    expect(napping).toBe(true);
    expect(gone).toBe(true);
    expect(read(join(loop, "ralph.log"))).toContain("ralph stopped by signal during iteration 1 (ralph stop)");
    expect(events(notes)).not.toContain("died");
    expect(existsSync(join(loop, "ralph.stop"))).toBe(false);
  });
});

describe.if(IS_WIN)("ralph start on Windows: the loop leaves the job of the shell that started it", () => {
  // An agent's shell tool keeps what it starts in a job object, and closing a
  // job made with KILL_ON_JOB_CLOSE ends everything in it. A loop started from
  // there died with the shell's session, by a signal nobody sent on purpose.
  // ok: a job that lets a process leave it (BREAKAWAY_OK). locked: one that
  // does not, which ralph start leaves through WMI. pinned: the same job, and
  // --in-job, which keeps the loop in it.
  const home = fx.p("job-home");
  const cases: Record<string, { flags: number; args: string[] }> = {
    ok: { flags: 0x2000 | 0x800, args: [] },
    locked: { flags: 0x2000, args: [] },
    pinned: { flags: 0x2000, args: ["--in-job"] },
  };
  const result: Record<string, { alive: boolean; warned: boolean; wmi: boolean; said: string; envLeft: boolean }> = {};

  setup(async () => {
    const { dlopen, FFIType } = await import("bun:ffi");
    const k = dlopen("kernel32.dll", {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
      SetInformationJobObject: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
      AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    }).symbols;
    for (const [name, { flags, args }] of Object.entries(cases)) {
      const loop = join(home, `job-${name}`);
      fx.makeRepo(fx.p(`app-job-${name}`), fx.p(`remote-job-${name}.git`));
      const S = fx.stub(`stub-job-${name}`, ["sleep"]);
      fx.makeLoop(loop, fx.p(`app-job-${name}`), { MAX_ITER: 1 });
      const job = k.CreateJobObjectW(null, null);
      // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes); LimitFlags at 16.
      const info = Buffer.alloc(144);
      info.writeUInt32LE(flags, 16);
      k.SetInformationJobObject(job, 9, info, 144);
      const cli = Bun.spawn([process.execPath, cliPath(), "start", `job-${name}`, ...args], {
        env: fx.env({ RALPH_HOME: home, STUB_DIR: S }),
        stdout: "pipe",
        stderr: "ignore",
      });
      // Into the job before it has loaded far enough to start the loop.
      const h = k.OpenProcess(0x1fffff, 0, cli.pid);
      k.AssignProcessToJobObject(job, h);
      k.CloseHandle(h);
      const said = await new Response(cli.stdout).text();
      await cli.exited;
      const pid = Number(read(join(loop, "ralph.pid")).trim());
      k.CloseHandle(job);
      await Bun.sleep(2000);
      const log = read(join(loop, "ralph.log"));
      result[name] = {
        alive: pid > 0 && alive(pid),
        warned: log.includes("so the loop ends when that job does"),
        wmi: log.includes("starting the loop outside it, through WMI"),
        said,
        envLeft: existsSync(join(loop, "ralph.start-env")),
      };
      fx.cli(home, ["stop", `job-${name}`]);
    }
  });

  test("a job that lets it leave: the loop outlives the job, or says it could not leave", () => {
    expect(result.ok!.alive || result.ok!.warned).toBe(true);
  });
  test("a job that does not: ralph start starts the loop outside it, through WMI, and it outlives the job", () => {
    expect(result.locked!.wmi).toBe(true);
    expect(result.locked!.warned).toBe(false);
    expect(result.locked!.alive).toBe(true);
    expect(result.locked!.said).toContain("started job-locked as PID");
    expect(result.locked!.envLeft).toBe(false);
  });
  test("--in-job keeps it in the job, and says the loop ends with it", () => {
    expect(result.pinned!.wmi).toBe(false);
    expect(result.pinned!.warned).toBe(true);
    expect(result.pinned!.alive).toBe(false);
  });
});
