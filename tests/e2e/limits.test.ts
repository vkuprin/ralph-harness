import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { Fx, type LoopRun, count, join, patchConfig, read, rows, setup, statuses, until } from "../helpers/index.ts";

const fx = new Fx("limits");

const sq = (s: string) => `'${s.split("'").join(`'\\''`)}'`;

/** The verdict column of a snapshot of results.tsv rows. */
const verdicts = (rs: string[][]) => rs.map((r) => r[4]).join(" ");

describe("limits heal themselves; interrupted iterations are set aside", () => {
  const app = fx.p("app-f");
  const remote = fx.p("remote-f.git");
  const loop = fx.p("loops/f");
  const W = fx.p("app-f-ralph-f");
  let S = "";
  // The first run, as it stood before the restart appended to it.
  let first: string[][] = [];
  let firstRemoteLog = "";
  let firstResults = "";
  let firstReviewCalls = "";

  setup(async () => {
    fx.makeRepo(app, remote);
    S = fx.stub("stub-f", ["limit", "weekly", "credit", "custom-limit", "fail429", "commit"], ["LIMIT", "ACCEPT"]);
    fx.makeLoop(loop, app, {
      WORKTREE: true,
      PUSH: true,
      REVIEW: true,
      MAX_ITER: 2,
      VERIFY_CMD: "./measure.sh",
      RATE_LIMIT_EXTRA_RE: "quota window closed",
    });
    await fx.runLoop(loop, S, { remote });
    first = rows(loop);
    firstRemoteLog = fx.git(remote, "log", "--format=%s", "main");
    firstResults = read(join(loop, "results.tsv"));
    firstReviewCalls = read(join(S, "review_calls")).trim();

    // A commit made by an iteration that never finished: nobody judged it.
    fx.git(W, "commit", "-q", "--allow-empty", "-m", "stub: from an interrupted iteration");
    writeFileSync(join(S, "modes"), "nothing\n");
    patchConfig(loop, { MAX_ITER: 1 });
    await fx.runLoop(loop, S, { remote });
  });

  test("every kind of limit is waited out, a real crash is not, and the work still ships", () => {
    expect(verdicts(first)).toBe("ratelimit ratelimit ratelimit ratelimit error keep");
  });
  test("waiting out limits did not use up MAX_ITER=2", () => {
    expect(firstRemoteLog).toContain("stub: work");
  });
  test("an agent crash whose output mentions 429 is an error, not a limit", () => {
    expect(first[4]?.[4]).toBe("error");
  });
  test("config.sh can extend RATE_LIMIT_RE", () => {
    expect(firstResults).toContain("quota window closed");
  });
  test("the reviewer waited out its limit and was asked again", () => {
    expect(firstReviewCalls).toBe("2");
  });
  test("that commit was reviewed, not waved through", () => {
    expect(first[first.length - 1]?.[4]).toBe("keep");
  });
  test("on restart the unjudged commit is set aside", () => {
    expect(verdicts(rows(loop).slice(-2))).toBe("drop:interrupted quiet");
  });
  test("the unjudged commit never reached origin", () => {
    expect(fx.git(remote, "log", "--format=%s", "main")).not.toContain("interrupted");
  });
  test("the unjudged commit is kept under refs/ralph/dropped/", () => {
    const refs = fx
      .git(W, "for-each-ref", "--format=%(refname)", "refs/ralph/dropped/")
      .split("\n")
      .filter((l) => l !== "");
    expect(refs.length).toBeGreaterThan(0);
    expect(fx.git(W, "log", "--format=%s", ...refs)).toContain("interrupted");
  });
});

describe("a reviewer limit that never clears", () => {
  // Waiting out a reviewer limit is right; waiting for ever is not. Some limits
  // never clear on their own (a spent credit balance), and while the loop waits
  // it is holding a commit no gate has judged. The ceiling hands the iteration
  // to the "reviewer unavailable" fallback.
  //
  // Thirty limits in a row: more than any ceiling, and the stub answers ACCEPT
  // once the queue runs dry, so an unbounded retry ends in a plain `keep`.
  const thirtyLimits = Array.from({ length: 30 }, () => "LIMIT");

  const rl1 = fx.p("loops/rl1");
  const rl2 = fx.p("loops/rl2");
  const rl3 = fx.p("loops/rl3");
  let S1 = "";
  let S3 = "";

  setup(async () => {
    fx.makeRepo(fx.p("app-rl1"), fx.p("remote-rl1.git"));
    S1 = fx.stub("stub-rl1", ["commit"], thirtyLimits);
    fx.makeLoop(rl1, fx.p("app-rl1"), {
      WORKTREE: true,
      REVIEW: true,
      MAX_ITER: 1,
      REVIEW_LIMIT_TRIES: 3,
      VERIFY_CMD: "./measure.sh",
    });
    await fx.runLoop(rl1, S1);

    // With no VERIFY_CMD the reviewer is the only gate, so giving up must not ship.
    fx.makeRepo(fx.p("app-rl2"), fx.p("remote-rl2.git"));
    const S2 = fx.stub("stub-rl2", ["commit"], thirtyLimits);
    fx.makeLoop(rl2, fx.p("app-rl2"), { WORKTREE: true, REVIEW: true, MAX_ITER: 1, REVIEW_LIMIT_TRIES: 2 });
    await fx.runLoop(rl2, S2);

    // A ceiling that cannot be switched off would be a new way to lose work, so
    // REVIEW_LIMIT_TRIES=0 keeps the old unbounded wait.
    fx.makeRepo(fx.p("app-rl3"), fx.p("remote-rl3.git"));
    S3 = fx.stub("stub-rl3", ["commit"], ["LIMIT", "LIMIT", "LIMIT", "ACCEPT"]);
    fx.makeLoop(rl3, fx.p("app-rl3"), {
      WORKTREE: true,
      REVIEW: true,
      MAX_ITER: 1,
      REVIEW_LIMIT_TRIES: 0,
      VERIFY_CMD: "./measure.sh",
    });
    await fx.runLoop(rl3, S3);
  });

  test("the reviewer is asked REVIEW_LIMIT_TRIES times and then no more", () => {
    expect(read(join(S1, "review_calls")).trim()).toBe("3");
  });
  test("the limit was waited out before giving up, not given up on at the first one", () => {
    expect(Number(read(join(S1, "review_calls")).trim())).toBeGreaterThan(1);
  });
  test("giving up reaches the reviewer-unavailable fallback, not a silent keep", () => {
    expect(statuses(rl1)).toBe("keep:unreviewed");
  });
  test("the row says the reviewer was stuck on a limit", () => {
    expect(read(join(rl1, "results.tsv"))).toContain("gave up at try 3 of 3");
  });
  test("the ceiling is reported in the log while it waits", () => {
    expect(read(join(rl1, "ralph.log"))).toContain("try 1 of 3");
  });
  test("with no other gate, a reviewer stuck on a limit ships nothing", () => {
    expect(statuses(rl2)).toBe("revert:review-unavailable");
  });
  test("the commit it could not review was reverted, not left on the branch", () => {
    expect(fx.git(fx.p("app-rl2-ralph-rl2"), "log", "--format=%s", "ralph/rl2")).not.toContain("stub: work");
  });
  test("REVIEW_LIMIT_TRIES=0 falls back to waiting, and the review still lands", () => {
    expect(statuses(rl3)).toBe("keep");
  });
  test("that loop really did wait out every limit", () => {
    expect(read(join(S3, "review_calls")).trim()).toBe("4");
  });
});

describe("LIMIT_RESET: a limit is waited out until the time it names", () => {
  // claude says when a limit lifts — "resets 9:10am (Europe/Paris)" — and with
  // LIMIT_RESET=1 the loop waits until that time. The wait is on the clock, so
  // the loop runs in the background on the fake clock, and the clock is moved
  // past the reset once the loop has said it is waiting.

  /** A limit message whose reset is `secs` from now, written in UTC the way the CLI writes a named zone. */
  function resetText(stub: string, secs: number): void {
    const at = new Date((Math.floor(Date.now() / 1000) + secs) * 1000);
    const h = at.getUTCHours();
    const hh = String(h % 12 === 0 ? 12 : h % 12).padStart(2, "0");
    const mm = String(at.getUTCMinutes()).padStart(2, "0");
    writeFileSync(join(stub, "limit-text"), `You've hit your session limit · resets ${hh}:${mm}${h < 12 ? "am" : "pm"} (UTC)\n`);
  }

  /** A notifier that records one line per event: event, loop, iter, dir, message. */
  function mkNotifier(log: string, script: string): void {
    writeFileSync(
      script,
      `#!/usr/bin/env bash
out=${sq(log)}
{ printf '%s\\t%s\\t%s\\t%s\\t' "$RALPH_EVENT" "$RALPH_LOOP" "$RALPH_ITER" "$RALPH_DIR"
  printf '%s' "$RALPH_MESSAGE" | tr '\\n\\t' '  '
  echo
} >> "$out"
`,
    );
    chmodSync(script, 0o755);
  }

  /** The loop in the background on the fake clock, at no offset. */
  function bgLoop(dir: string, stub: string, clock: string): LoopRun {
    writeFileSync(clock, "0\n");
    return fx.startLoop(dir, stub, { env: { RALPH_TEST_CLOCK: clock } });
  }

  /** The loop has logged `text` within `secs`. */
  const untilLog = (dir: string, text: string, secs: number) => until(() => read(join(dir, "ralph.log")).includes(text), secs);

  /**
   * The run ended by itself within `secs`. If not, it is stopped through the PID
   * in its own lock and this says false, instead of hanging the suite for the
   * hours it would have waited.
   */
  async function endLoop(dir: string, run: LoopRun, secs: number): Promise<boolean> {
    const within = (s: number) => Promise.race([run.done.then(() => true), Bun.sleep(s * 1000).then(() => false)]);
    if (await within(secs)) return true;
    const pid = Number(read(join(dir, "ralph.lock")).trim());
    try {
      if (pid) process.kill(pid, "SIGTERM");
      else run.proc.kill("SIGTERM");
    } catch {}
    if (!(await within(10))) run.proc.kill("SIGKILL");
    await run.done;
    return false;
  }

  const lr = fx.p("loops/lr");
  const lr2 = fx.p("loops/lr2");
  const lr3 = fx.p("loops/lr3");
  const lr4 = fx.p("loops/lr4");
  const notifyLog = fx.p("notify-lr.log");
  let S3 = "";
  const r = {
    lrWaits: false,
    lrAgentCalls: "",
    lrEnded: false,
    lr2Ended: false,
    lr3Ended: false,
    lr4Waits: false,
    lr4Ended: false,
  };

  setup(async () => {
    fx.makeRepo(fx.p("app-lr"), fx.p("remote-lr.git"));
    const S = fx.stub("stub-lr", ["say-limit", "commit"]);
    resetText(S, 7200);
    mkNotifier(notifyLog, fx.p("notify-lr.sh"));
    fx.makeLoop(lr, fx.p("app-lr"), {
      WORKTREE: true,
      MAX_ITER: 1,
      LIMIT_RESET: true,
      ACTIVE_POLL: 1,
      ITER_TIMEOUT: 600,
      NOTIFY_CMD: fx.p("notify-lr.sh"),
    });
    const clockLr = fx.p("clock-lr");
    const bg = bgLoop(lr, S, clockLr);
    r.lrWaits = await untilLog(lr, "waiting until then", 30);
    await Bun.sleep(2000);
    r.lrAgentCalls = read(join(S, "agent_calls")).trim();
    writeFileSync(clockLr, "10800\n");
    r.lrEnded = await endLoop(lr, bg, 60);

    // A reset time that has just gone by is a late reset, not tomorrow's, and a
    // message with no time in it waits RATE_LIMIT_SLEEP as it always did. Both
    // under the watchdog: the defect here is a wait of a day.
    fx.makeRepo(fx.p("app-lr2"), fx.p("remote-lr2.git"));
    const S2 = fx.stub("stub-lr2", ["say-limit", "credit", "commit"]);
    resetText(S2, -600);
    fx.makeLoop(lr2, fx.p("app-lr2"), { WORKTREE: true, MAX_ITER: 1, LIMIT_RESET: true, ACTIVE_POLL: 1 });
    r.lr2Ended = await endLoop(lr2, bgLoop(lr2, S2, fx.p("clock-lr2")), 30);

    // The reviewer holds a commit no gate has judged while it waits, so its wait
    // keeps a ceiling: REVIEW_LIMIT_TRIES * RATE_LIMIT_SLEEP seconds, two hours
    // here. A reset three hours out is past it, and the review is given up at once.
    fx.makeRepo(fx.p("app-lr3"), fx.p("remote-lr3.git"));
    S3 = fx.stub("stub-lr3", ["commit"], ["LIMIT"]);
    resetText(S3, 10800);
    fx.makeLoop(lr3, fx.p("app-lr3"), {
      WORKTREE: true,
      REVIEW: true,
      MAX_ITER: 1,
      LIMIT_RESET: true,
      ACTIVE_POLL: 1,
      RATE_LIMIT_SLEEP: 600,
      REVIEW_LIMIT_TRIES: 12,
      VERIFY_CMD: "./measure.sh",
    });
    r.lr3Ended = await endLoop(lr3, bgLoop(lr3, S3, fx.p("clock-lr3")), 30);

    // Inside the ceiling — REVIEW_LIMIT_TRIES=0 has none — the reset is waited for.
    fx.makeRepo(fx.p("app-lr4"), fx.p("remote-lr4.git"));
    const S4 = fx.stub("stub-lr4", ["commit"], ["LIMIT", "ACCEPT"]);
    resetText(S4, 7200);
    fx.makeLoop(lr4, fx.p("app-lr4"), {
      WORKTREE: true,
      REVIEW: true,
      MAX_ITER: 1,
      LIMIT_RESET: true,
      ACTIVE_POLL: 1,
      REVIEW_LIMIT_TRIES: 0,
      ITER_TIMEOUT: 600,
    });
    const clockLr4 = fx.p("clock-lr4");
    const bg4 = bgLoop(lr4, S4, clockLr4);
    r.lr4Waits = await untilLog(lr4, "reviewer hit a limit that resets at", 30);
    writeFileSync(clockLr4, "10800\n");
    r.lr4Ended = await endLoop(lr4, bg4, 60);
  });

  test("the loop waits for the time the message names", () => {
    expect(r.lrWaits).toBe(true);
  });
  test("and does not ask again before it", () => {
    expect(r.lrAgentCalls).toBe("1");
  });
  test("once the clock passes it, the same iteration runs again", () => {
    expect(r.lrEnded).toBe(true);
  });
  test("and ships", () => {
    expect(statuses(lr)).toBe("ratelimit keep");
  });
  test("the limit notification says when the loop goes on", () => {
    const limitLines = read(notifyLog)
      .split("\n")
      .filter((l) => l.startsWith("limit"));
    expect(limitLines.some((l) => l.includes("waiting until"))).toBe(true);
  });
  test("a reset ten minutes ago does not wait until tomorrow", () => {
    expect(r.lr2Ended).toBe(true);
  });
  test("it and a credit message both fall back to RATE_LIMIT_SLEEP", () => {
    expect(count(read(join(lr2, "ralph.log")), /trying it again in 0s/)).toBe(2);
  });
  test("and neither is read as a reset time", () => {
    expect(read(join(lr2, "ralph.log"))).not.toContain("waiting until");
  });
  test("the iteration still ships", () => {
    expect(statuses(lr2)).toBe("ratelimit ratelimit keep");
  });
  test("a reviewer limit past the ceiling is given up at once", () => {
    expect(r.lr3Ended).toBe(true);
  });
  test("and the commit falls back to VERIFY_CMD", () => {
    expect(statuses(lr3)).toBe("keep:unreviewed");
  });
  test("with the reset time in the reason", () => {
    expect(read(join(lr3, "results.tsv"))).toContain("past the REVIEW_LIMIT_TRIES ceiling");
  });
  test("the reviewer was asked once", () => {
    expect(read(join(S3, "review_calls")).trim()).toBe("1");
  });
  test("a reviewer limit inside the ceiling is waited for", () => {
    expect(r.lr4Waits).toBe(true);
  });
  test("and the reviewer is asked again after it", () => {
    expect(r.lr4Ended).toBe(true);
  });
  test("whose answer decides", () => {
    expect(statuses(lr4)).toBe("keep");
  });
});
