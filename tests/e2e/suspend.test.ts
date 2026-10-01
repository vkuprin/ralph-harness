import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { Fx, basename, join, read, rows, setup, sleeperGone, sq, statuses } from "../helpers/index.ts";

const fx = new Fx("suspend");

describe("time asleep is not time worked", () => {
  // Every timeout was wall clock, so a laptop suspended mid-iteration killed a
  // healthy agent on the first poll after the wake. A suspend cannot be waited
  // for, so it is simulated: the fake clock adds the seconds in RALPH_TEST_CLOCK
  // to the time, and the stub writes that file from inside the iteration.
  const app = fx.p("app-susp");
  const susp = fx.p("loops/susp");
  const susp2 = fx.p("loops/susp2");
  const susp3 = fx.p("loops/susp3");
  const susp4 = fx.p("loops/susp4");
  let S2 = "";

  /** The loop on the fake clock, with an offset file of its own starting at 0. */
  async function runSlept(dir: string, stub: string, work = "1"): Promise<number> {
    const clock = fx.p(`clock-${basename(dir)}`);
    writeFileSync(clock, "0\n");
    return fx.runLoop(dir, stub, { env: { RALPH_TEST_CLOCK: clock, FAKE_WORK: work } });
  }

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-susp.git"));

    const S = fx.stub("stub-susp", ["suspend"]);
    fx.makeLoop(susp, app, { WORKTREE: true, MAX_ITER: 1, ITER_TIMEOUT: 600 });
    await runSlept(susp, S);

    // Guard: the budget is spent by awake seconds, not refunded. An agent that
    // hangs after the suspend is still killed.
    S2 = fx.stub("stub-susp2", ["suspend"]);
    fx.makeLoop(susp2, app, { WORKTREE: true, MAX_ITER: 1, ITER_TIMEOUT: 2 });
    await runSlept(susp2, S2, "999");

    // VERIFY_CMD runs through the same bound, and so does the push.
    const S3 = fx.stub("stub-susp3", ["commit"]);
    fx.makeLoop(susp3, app, {
      WORKTREE: true,
      MAX_ITER: 1,
      VERIFY_TIMEOUT: 600,
      VERIFY_CMD: `echo 20000 > ${sq(fx.p("clock-susp3"))}; sleep 1; ./measure.sh`,
    });
    await runSlept(susp3, S3);

    // POLL_GAP_MAX is a tolerance, not an opt-out: 0 falls back to the default
    // instead of to no cap, and says nothing every poll.
    const S4 = fx.stub("stub-susp4", ["suspend"]);
    fx.makeLoop(susp4, app, { WORKTREE: true, MAX_ITER: 1, ITER_TIMEOUT: 600, POLL_GAP_MAX: 0 });
    await runSlept(susp4, S4);
  });

  test("an agent working across a 20000s suspend is not killed", () => {
    expect(statuses(susp)).toBe("keep");
  });
  test("its commit survived the wake", () => {
    expect(fx.git(fx.p("app-susp-ralph-susp"), "log", "--format=%s")).toContain("stub: work");
  });
  test("and no timeout is blamed in the reason either", () => {
    expect(read(join(susp, "results.tsv"))).not.toMatch(/timed out|killed after/);
  });
  // Guard: the clock really did jump, so the checks above are not passing
  // because nothing happened. The recorded seconds stay wall clock on purpose.
  test("the recorded seconds still show the wall clock the human sees", () => {
    const r = rows(susp);
    expect(Number(r[r.length - 1]?.[5])).toBeGreaterThanOrEqual(20000);
  });
  test("an agent that hangs after the suspend is still killed", () => {
    expect(statuses(susp2)).toBe("timeout");
  });
  test("and its process group went with it", () => {
    expect(sleeperGone(join(S2, "sleeper.pid"))).toBe(true);
  });
  test("a VERIFY_CMD that runs across a suspend is not killed either", () => {
    expect(statuses(susp3)).toBe("keep");
  });
  test("a POLL_GAP_MAX of 0 falls back to the default, not to no cap", () => {
    expect(statuses(susp4)).toBe("keep");
  });
  test("and does not complain once per poll", () => {
    expect(read(join(susp4, "ralph.log"))).not.toContain("integer expression");
  });
});
