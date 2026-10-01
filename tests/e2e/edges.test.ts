import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import {
  Fx,
  type HookAnswer,
  IS_WIN,
  count,
  events,
  field,
  join,
  lines,
  loopArgv,
  mkNotifier,
  noProc,
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
    const t0 = Date.now();
    await fx.runLoop(loop2, fx.stub("stub-es2", ["fail", "fail", "nothing"]));
    took = Date.now() - t0;
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
    term(loop, run.proc);
    code = await Promise.race([run.done, Bun.sleep(15000).then(() => -1)]);
    took = Date.now() - t0;
    if (code === -1) run.proc.kill("SIGKILL");
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
  test("so it never reaches origin, and is kept under refs/ralph/dropped/", () => {
    const main = fx.git(remote, "log", "--format=%s", "main");
    expect(main).toContain("human: add human.txt");
    expect(main).not.toContain("stub: work");
    expect(fx.git(fx.p("app-rev-ralph-rev"), "for-each-ref", "refs/ralph/dropped/")).not.toBe("");
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
    expect(events(churnNote).filter((e: string) => e === "churn")).toEqual(["churn"]);
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
    first.proc.kill("SIGKILL");
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
});
