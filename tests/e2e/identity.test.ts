import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { Fx, IS_WIN, alive, count, join, noProc, read, readConfigValue, setup, sleeperGone, term, until } from "../helpers/index.ts";

const fx = new Fx("identity");

/** A stranger: a process that is not a loop and now owns the number a dead loop left behind. */
function stranger(): Bun.Subprocess {
  // Long enough to outlive the checks around it, which each test kills it
  // after: on a Windows runner a `ralph status` and a `ralph stop`, reading
  // processes through CIM, took more than 41s, and a stranger that had simply
  // finished read as one the stop had killed.
  return Bun.spawn(["sleep", "600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

describe("a PID is not an identity: ralph.pid and ralph.lock left by a dead loop", () => {
  // A loop that ends by `kill -9`, the OOM killer or a reboot leaves both files
  // behind holding a number the kernel then hands to somebody else.
  const app = fx.p("app-p");
  const home = fx.p("home-p");
  const stale = join(home, "stale");
  const other = join(home, "other");
  let staleStatus = "";
  let stopRc = 0;
  let pidStrangerAlive = false;
  let otherStatus = "";
  let lockStrangerAlive = false;

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-p.git"));
    const S = fx.stub("stub-p", ["nothing"]);
    fx.makeLoop(stale, app, { MAX_ITER: 1 });

    const bystander = stranger();
    try {
      writeFileSync(join(stale, "ralph.pid"), `${bystander.pid}\n`);
      staleStatus = fx.cli(home, ["status", "stale"]).out;
      stopRc = fx.cli(home, ["stop", "stale"]).code;
      pidStrangerAlive = alive(bystander.pid);
    } finally {
      bystander.kill();
    }

    // The recycled number could be another loop's, which is why the check is
    // this loop's own command line and not merely "some loop is alive".
    const S2 = fx.stub("stub-p2", ["sleep"]);
    fx.makeLoop(other, app, { MAX_ITER: 1, ITER_TIMEOUT: 600 });
    fx.cli(home, ["start", "other"], { STUB_DIR: S2 });
    try {
      await until(() => read(join(S2, "modes.done")) !== "", 10);
      copyFileSync(join(other, "ralph.pid"), join(stale, "ralph.pid"));
      fx.cli(home, ["stop", "stale"]);
      otherStatus = fx.cli(home, ["status", "other"]).out;
    } finally {
      fx.cli(home, ["stop", "other"]);
    }

    // The lock is the loop's own, and a recycled PID there stopped it starting at all.
    const holder = stranger();
    try {
      writeFileSync(join(stale, "ralph.lock"), `${holder.pid}\n`);
      await fx.runLoop(stale, S);
      lockStrangerAlive = alive(holder.pid);
    } finally {
      holder.kill();
    }
  });

  test("status does not call a recycled PID a running loop", () => {
    expect(staleStatus).toContain("stopped");
  });
  test("stop says the loop is not running", () => {
    expect(stopRc).not.toBe(0);
  });
  test("stop leaves the stranger who now owns that PID alone", () => {
    expect(pidStrangerAlive).toBe(true);
  });
  test("stopping one loop does not stop the loop next door", () => {
    expect(otherStatus).toContain("running");
  });
  test("a lock left by a dead loop does not block the next start", () => {
    expect(read(join(stale, "ralph.log"))).toContain("ralph finished");
  });
  test("the stranger holding the lock's PID survived that too", () => {
    expect(lockStrangerAlive).toBe(true);
  });
});

// Windows reads a command line from CIM, not ps, and nobody has run this there.
describe.skipIf(IS_WIN)("a loop whose paths hold letters past ASCII, driven from a shell without a UTF-8 locale", () => {
  // The repo and RALPH_HOME each hold a space and an ø (a home like
  // /Users/jørgen), and so does the loop name, which git allows in a branch.
  // The CLI runs in the C locale, as it does from cron, launchd or an ssh
  // session that sent no LANG. ps escaped every byte past ASCII there (macOS
  // printed ø as M-CM-8; procps, by its source, writes ?), the loop's
  // directory matched nothing on its command line, and a running loop read as
  // stopped: `ralph stop` said it was not running and left it, agent and all.
  const app = fx.p("my app ø");
  const home = fx.p("hø me");
  const name = "ø";
  const loop = join(home, name);
  const C = { LANG: "C", LC_ALL: "C" };
  let S = "";
  let newRc = -1;
  let repoBack: string | undefined;
  let startRc = -1;
  let pid = 0;
  let running = "";
  let runningAll = "";
  let second = { code: -1, text: "" };
  let review = "";
  let stop = { code: -1, text: "" };
  let loopGone = false;
  let agentGone = false;
  let stopped = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-ø.git"));
    S = fx.stub("stub-ø", ["commit", "sleep"]);
    const sets = ["QUIET_SLEEP=0", "STEP_SLEEP=0", "ERROR_SLEEP=0", "VERIFY_CMD=./measure.sh", "MAX_ITER=3"];
    newRc = fx.cli(home, ["new", name, `${app}/`, ...sets.flatMap((s) => ["--set", s])], C).code;
    repoBack = readConfigValue(join(loop, "config.json"), "REPO");
    startRc = fx.cli(home, ["start", name], { ...C, STUB_DIR: S }).code;
    try {
      // The second iteration is in its sleep once the stub has recorded the sleeper.
      await until(() => read(join(S, "sleeper.pid")).trim() !== "", 30);
      pid = Number(read(join(loop, "ralph.pid")).trim());
      running = fx.cli(home, ["status", name], C).out;
      runningAll = fx.cli(home, ["status"], C).out;
      const r = fx.cli(home, ["start", name], { ...C, STUB_DIR: S });
      second = { code: r.code, text: r.out + r.err };
      review = fx.cli(home, ["review", name], C).out;
      const s = fx.cli(home, ["stop", name], C);
      stop = { code: s.code, text: s.out + s.err };
      loopGone = await until(() => !alive(pid), 20);
      agentGone = sleeperGone(join(S, "sleeper.pid"));
      stopped = fx.cli(home, ["status", name], C).out;
    } finally {
      // The loop is not this test's child, so `kill -0` answers for it alone.
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      const sleeper = Number(read(join(S, "sleeper.pid")).trim());
      if (sleeper && alive(sleeper)) process.kill(sleeper, "SIGKILL");
    }
  });

  test("ralph new takes the repo path, trailing slash and all", () => {
    expect(newRc).toBe(0);
    expect(repoBack).toBe(app);
  });
  test("ralph start starts it", () => {
    expect(startRc).toBe(0);
    expect(pid).toBeGreaterThan(0);
  });
  test("status calls the running loop running", () => {
    expect(running).toContain("running");
    expect(running).toContain(`${app}-ralph-${name}`);
  });
  test("so does the status of every loop", () => {
    expect(runningAll).toContain("running");
  });
  test("a second start is refused by the CLI, not by the loop's lock after the CLI said started", () => {
    expect(second.code).not.toBe(0);
    expect(second.text).toContain("already running");
  });
  test("review lists the commit the first iteration shipped", () => {
    expect(review.slice(review.indexOf("Shipped"))).toContain("stub: work (agent call 1)");
  });
  test("stop stops it", () => {
    expect(stop.code).toBe(0);
    expect(stop.text).toContain(`stopped ${name}`);
    expect(loopGone).toBe(true);
  });
  test("and the agent's process group with it", () => {
    expect(agentGone).toBe(true);
  });
  test("status then says stopped", () => {
    expect(stopped).toContain("stopped");
  });
});

// Not on Windows: reapOrphan has not been run there, and returns nothing.
describe.skipIf(IS_WIN)("ralph stop on a loop killed without its handler stops the agent it left running", () => {
  // kill -9, the OOM killer or bun crashing ends the loop with no handler run,
  // and its agent goes on in a process group of its own, bounded by nothing:
  // the loop that would enforce ITER_TIMEOUT is gone. `ralph stop` said the
  // loop was not running and left the agent writing into the worktree until
  // the next `ralph start`, which a human who has just run `ralph stop` has no
  // reason to run.
  const app = fx.p("app-orphan");
  const home = fx.p("home-orphan");
  const dead = join(home, "dead");
  const live = join(home, "live");
  let S = "";
  let L = "";
  let agent = 0;
  let outlived = false;
  let stop = { code: -1, out: "", err: "" };
  let again = { code: -1, out: "", err: "" };
  let liveStop = { code: -1, out: "", err: "" };
  let liveAgentRunning = false;
  let status = "";
  let statusAll = "";
  let help = "";
  let askedAlive = false;
  let statusAfter = "";
  let liveStatus = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-orphan.git"));
    fx.makeLoop(dead, app, { MAX_ITER: 1, ITER_TIMEOUT: 600 });
    S = fx.stub("stub-orphan", ["sleep"]);
    const first = fx.startLoop(dead, S);
    await until(() => read(join(S, "sleeper.pid")).trim() !== "", 30);
    agent = Number(fx.sh(["ps", "-o", "ppid=", "-p", read(join(S, "sleeper.pid")).trim()]).out.trim());
    first.kill("SIGKILL");
    await first.done;
    outlived = !sleeperGone(join(S, "sleeper.pid"));
    // Asking first, the way a human would: status said a bare `stopped` over
    // an agent still writing into the checkout.
    status = fx.cli(home, ["status", "dead"]).out;
    statusAll = fx.cli(home, ["status"]).out;
    help = fx.cli(home, ["help"]).out;
    askedAlive = !sleeperGone(join(S, "sleeper.pid")) && existsSync(join(dead, ".child"));
    stop = fx.cli(home, ["stop", "dead"]);
    again = fx.cli(home, ["stop", "dead"]);
    statusAfter = fx.cli(home, ["status", "dead"]).out;

    // The mark names a running loop's agent while nothing names the loop: its
    // ralph.lock is gone, and it was not started by `ralph start`, so there is
    // no ralph.pid. Its agent's start matches the mark, so only its parent
    // tells it from an orphan, and that parent is a loop.
    fx.makeLoop(live, app, { MAX_ITER: 1, ITER_TIMEOUT: 600 });
    L = fx.stub("stub-orphan-live", ["sleep"]);
    const second = fx.startLoop(live, L);
    try {
      await until(() => read(join(L, "sleeper.pid")).trim() !== "", 30);
      rmSync(join(live, "ralph.lock"), { force: true });
      liveStatus = fx.cli(home, ["status", "live"]).out;
      liveStop = fx.cli(home, ["stop", "live"]);
      liveAgentRunning = !sleeperGone(join(L, "sleeper.pid"));
    } finally {
      term(live, second);
      await second.done;
    }
  });
  afterAll(() => {
    // Against a stop that reaps nothing the agent is still running, and a
    // failed check leaves nothing behind for the next test to trip on.
    if (agent > 1 && !noProc(`--add-dir ${dead} `)) {
      try {
        process.kill(-agent, "SIGKILL");
      } catch {}
    }
  });

  test("the agent outlived the loop that started it", () => {
    expect(agent).toBeGreaterThan(1);
    expect(outlived).toBe(true);
  });
  test("status and help say it is still running, and how to stop it, without stopping it", () => {
    const said = `left over   PID ${agent}, which its last run left running when it died, is still running — stop it: ralph stop dead`;
    expect(status).toContain("stopped");
    expect(status).toContain(said);
    expect(statusAll).toContain(said);
    expect(help).toContain("dead (stopped, but left a process running)");
    expect(askedAlive).toBe(true);
  });
  test("and once it is stopped, status says only stopped", () => {
    expect(statusAfter).toContain("stopped");
    expect(statusAfter).not.toContain("left over");
  });
  test("stop stopped it and its whole group, and said so", () => {
    expect(stop.code).toBe(0);
    expect(stop.out).toContain(`PID ${agent}, which its last run left running when it died`);
    expect(count(stop.out, /left running when it died/)).toBe(1);
    expect(read(join(dead, "ralph.log"))).toContain(`ralph stop: PID ${agent}, which its last run left running`);
    expect(sleeperGone(join(S, "sleeper.pid"))).toBe(true);
    expect(noProc(`--add-dir ${dead} `)).toBe(true);
  });
  test("and leaves no mark behind, so a second stop finds nothing", () => {
    expect(existsSync(join(dead, ".child"))).toBe(false);
    expect(again.code).toBe(1);
    expect(again.err).toContain("dead is not running");
  });
  test("an agent whose parent is a running loop is that loop's, not an orphan", () => {
    expect(liveStop.code).toBe(1);
    expect(liveStop.err).toContain("live is not running");
    expect(liveAgentRunning).toBe(true);
    expect(liveStatus).not.toContain("left over");
  });
});
