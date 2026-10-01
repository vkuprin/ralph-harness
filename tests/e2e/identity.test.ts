import { describe, expect, test } from "bun:test";
import { copyFileSync, writeFileSync } from "node:fs";
import { Fx, IS_WIN, alive, join, read, readConfigValue, setup, sleeperGone, until } from "../helpers/index.ts";

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
