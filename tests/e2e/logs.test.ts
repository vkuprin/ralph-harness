import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { Fx, IS_WIN, alive, count, join, noProc, read, rows, setup, statuses, until, writeConfig } from "../helpers/index.ts";

const fx = new Fx("logs");

/** Every `ralph.log*` in a loop directory, the way `cat "$D"/ralph.log*` reads them. */
function logFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.startsWith("ralph.log"))
    .sort()
    .map((f) => join(dir, f));
}
const allLogs = (dir: string) => logFiles(dir).map(read).join("");
const lineCount = (text: string) => text.split("\n").length - 1;

describe("days, not minutes: a soak run over a rotating log", () => {
  // Nothing had ever run here for longer than a dozen iterations. 200 of them
  // with no sleeps is about a week of a real loop with the waiting taken out:
  // long enough for the log to rotate many times over, and for anything that
  // leaks once per iteration to have leaked 200 times by the end.
  const app = fx.p("app-soak");
  const home = fx.p("home-soak");
  const D = join(home, "soak");
  let soakCur = 0;
  let soakAll = 0;
  let status = "";
  let logOut = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-soak.git"));
    const S = fx.stub("stub-soak", ["commit", "commit", "commit"]); // then "nothing" for the rest
    fx.makeLoop(D, app, { MAX_ITER: 200, LOG_MAX_BYTES: 4000, LOG_KEEP: 3 });
    await fx.runLoop(D, S, { env: { RALPH_HOME: home } });
    soakCur = count(read(join(D, "ralph.log")), /=== iteration/);
    soakAll = count(allLogs(D), /=== iteration/);
    status = fx.cli(home, ["status", "soak"]).out;
    logOut = fx.cli(home, ["log", "soak", "100"]).out;
  });

  test("200 iterations ran", () => {
    expect(rows(D).length).toBe(200);
  });
  test("results.tsv counts up to the last one", () => {
    expect(rows(D).at(-1)?.[1]).toBe("200");
  });
  test("the verdicts add up: 3 keeps and 197 quiet", () => {
    const v = rows(D)
      .map((r) => r[4])
      .join("\n");
    expect(count(v, /keep/)).toBe(3);
    expect(count(v, /quiet/)).toBe(197);
  });
  test("the log rotated", () => {
    expect(existsSync(join(D, "ralph.log.1"))).toBe(true);
  });
  test("rotation keeps LOG_KEEP files and no more", () => {
    expect(existsSync(join(D, "ralph.log.3"))).toBe(true);
    expect(existsSync(join(D, "ralph.log.4"))).toBe(false);
  });
  test("the log stops growing: all of it together stays near the limit", () => {
    const bytes = logFiles(D).reduce((n, f) => n + statSync(f).size, 0);
    expect(bytes).toBeLessThan(30000);
  });
  test("the newest log alone has lost most of the history", () => {
    expect(soakCur).toBeLessThan(soakAll);
  });
  test("status counts iterations across the rotated logs", () => {
    expect(status).toContain(`iterations  ${soakAll} run`);
  });
  test("ralph log reads the rotated files too", () => {
    expect(lineCount(logOut)).toBe(100);
  });
  test("the progress cap says its piece once, not once per iteration", () => {
    expect(count(allLogs(D), /progress cap/)).toBeLessThanOrEqual(1);
  });
  test("PROGRESS.md is still the file it started as", () => {
    const f = join(D, "PROGRESS.md");
    expect(read(f)).toMatch(/^## Needs a decision/m);
    expect(statSync(f).size).toBeLessThan(8000);
  });
  test("no process was left behind", () => {
    expect(noProc(home)).toBe(true);
  });
  test("the lock is released", () => {
    expect(existsSync(join(D, "ralph.lock"))).toBe(false);
  });
});

describe("rotated logs past ralph.log.9", () => {
  // LOG_KEEP has no ceiling, so a loop asked to keep more history rotates into
  // ralph.log.10 and up. Both sides used to assume the count was fixed: the CLI
  // walked a hardcoded 9..1, and rotation removed exactly the file at LOG_KEEP.
  const app = fx.p("app-logn");
  const home = fx.p("home-logn");
  const D = join(home, "deep");
  const O = join(home, "orphan");
  let status = "";
  let logOut = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-logn.git"));
    fx.makeLoop(D, app, { LOG_KEEP: 12 });
    for (let i = 12; i >= 1; i--) writeFileSync(join(D, `ralph.log.${i}`), `[2026-01-01 00:00:00] === iteration ${i} ===\n`);
    writeFileSync(join(D, "ralph.log"), "[2026-01-01 00:00:00] === iteration 13 ===\n");
    status = fx.cli(home, ["status", "deep"]).out;
    logOut = fx.cli(home, ["log", "deep", "20"]).out;

    // Lowering LOG_KEEP used to leave every file above the new number behind
    // for good, so the bound of LOG_MAX_BYTES * (LOG_KEEP + 1) was not a bound
    // at all — and once the CLI could read past nine it would read that stale
    // file for ever.
    const S = fx.stub("stub-logn", ["nothing"]);
    fx.makeLoop(O, app, { MAX_ITER: 6, LOG_MAX_BYTES: 200, LOG_KEEP: 2 });
    writeFileSync(join(O, "ralph.log.5"), "left over from when LOG_KEEP was higher\n");
    await fx.runLoop(O, S, { env: { RALPH_HOME: home } });
  });

  test("status counts the iterations in ralph.log.10 and up", () => {
    expect(status).toContain("iterations  13 run");
  });
  test("ralph log reads past ralph.log.9", () => {
    expect(logOut).toContain("iteration 12 ");
  });
  // The oldest file is ralph.log.12. A glob would sort it under ralph.log.2 and
  // hand the history back shuffled, so this pins the order as numeric.
  test("the log is read oldest first, by number and not by name", () => {
    expect(logOut.split("\n")[0]).toBe("[2026-01-01 00:00:00] === iteration 12 ===");
  });
  test("the run rotated at all, so the check below means something", () => {
    expect(existsSync(join(O, "ralph.log.1"))).toBe(true);
  });
  test("rotation prunes the logs left above a lowered LOG_KEEP", () => {
    expect(existsSync(join(O, "ralph.log.5"))).toBe(false);
  });
  test("rotation still keeps the LOG_KEEP files below it", () => {
    expect(existsSync(join(O, "ralph.log.2"))).toBe(true);
    expect(existsSync(join(O, "ralph.log.3"))).toBe(false);
  });
});

describe("refs/ralph/ is a safety net, not a leak", () => {
  // Every reverted or dropped iteration saved its commits under refs/ralph/,
  // and nothing ever removed one. A ref is also the only thing keeping those
  // commits reachable, so `git gc` could never reclaim the objects. The refs
  // are now kept like the logs are, newest REF_KEEP of each.
  const app = fx.p("app-refs");
  const loop = fx.p("loops/refs");
  const W = fx.p("app-refs-ralph-refs");
  let refsGone = "";
  let keptRefs: string[] = [];
  let keptSubjects = "";
  let revAll: string[] = [];
  let gcOk = false;
  let stillThere = true;

  // `ralph review` sorted these by refname, and refs/ralph/<name>/reverted/
  // sorts above refs/ralph/<name>/dropped/, so a loop with more reverts than
  // the listing shows never showed a dropped commit at all.
  const mixed = fx.p("app-mixed");
  const home = fx.p("home-refs");
  let review = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-refs.git"));
    const S = fx.stub("stub-refs", ["commit-bad", "commit-bad", "commit-bad", "commit-bad", "commit-bad"]);
    fx.makeLoop(loop, app, { WORKTREE: true, MAX_ITER: 5, REF_KEEP: 2, VERIFY_CMD: "./measure.sh" });
    await fx.runLoop(loop, S);
    refsGone = rows(loop)[0]?.[3] ?? "";
    keptRefs = fx
      .git(W, "for-each-ref", "--format=%(refname)", "refs/ralph/refs/reverted/")
      .split("\n")
      .filter((l) => l !== "");
    keptSubjects = fx.git(W, "log", "--no-walk", "--format=%s", ...keptRefs);
    revAll = fx.git(W, "rev-list", "--all").split("\n");
    // Unreachable from every ref is the whole point: until then no amount of
    // `git gc` could shrink the repository back.
    gcOk = fx.gitOk(W, "reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all") && fx.gitOk(W, "gc", "--prune=now", "-q");
    stillThere = fx.gitOk(W, "cat-file", "-e", `${refsGone}^{commit}`);

    fx.makeRepo(mixed, fx.p("remote-mixed.git"));
    mkdirSync(join(home, "mixed"), { recursive: true });
    writeConfig(join(home, "mixed"), { REPO: mixed });
    for (let i = 1; i <= 12; i++) {
      fx.git(mixed, "commit", "-q", "--allow-empty", "-m", `gate rejected this one (${i})`);
      fx.git(mixed, "update-ref", `refs/ralph/mixed/reverted/${1758400000 + i}-${i}`, "HEAD");
    }
    fx.git(mixed, "commit", "-q", "--allow-empty", "-m", "a rebase conflict dropped this");
    fx.git(mixed, "update-ref", "refs/ralph/mixed/dropped/1758500000", "HEAD");
    fx.git(mixed, "reset", "-q", "--hard", "HEAD~13");
    review = fx.cli(home, ["review", "mixed"]).out;
  });

  test("five iterations were reverted, so the checks below mean something", () => {
    expect(statuses(loop)).toBe("revert:verify revert:verify revert:verify revert:verify revert:verify");
  });
  test("refs/ralph/<name>/reverted/ is bounded by REF_KEEP", () => {
    expect(keptRefs.length).toBe(2);
  });
  test("the newest thrown-away commits are the ones kept", () => {
    expect(keptSubjects).toContain("agent call 5");
  });
  test("a pruned commit is no longer reachable from any ref", () => {
    expect(refsGone).not.toBe("");
    expect(revAll.some((l) => l.startsWith(refsGone))).toBe(false);
  });
  test("and git gc can then reclaim it", () => {
    expect(gcOk).toBe(true);
    expect(stillThere).toBe(false);
  });
  test("review lists the newest thrown-away commits, dropped ones included", () => {
    expect(review).toContain("a rebase conflict dropped this");
  });
  test("review still lists the reverted ones", () => {
    expect(review).toContain("gate rejected this one (12)");
  });
  // By epoch and not by name: 1758400010-10 sorts under 1758400002-2 lexically.
  test("review orders them newest first by time, not by name", () => {
    const all = review.split("\n");
    const from = all.findIndex((l) => l.includes("Reverted or dropped"));
    expect(from).toBeGreaterThanOrEqual(0);
    expect((all[from + 2] ?? "").replace(/.* {2}/, "")).toBe("(ralph/mixed/reverted/1758400012-12)");
  });
});

describe("loops that share a repository keep their own thrown-away commits", () => {
  // A ref was refs/ralph/<kind>/<epoch>-<iteration>, with no loop in it, and a
  // ref belongs to the repository, not to a worktree. So a loop's REF_KEEP let
  // go of every other loop's thrown-away commits, and `ralph review` listed them
  // all as its own. Measured: b, with REF_KEEP 0 ("keeps every ref"), reverted
  // two commits; a, with REF_KEEP 1, reverted two more; b's two were gone.
  const home = fx.p("home-shared");
  const app = fx.p("app-shared");
  const A = join(home, "a");
  const B = join(home, "b");
  let aShas: string[] = [];
  let bShas: string[] = [];
  let legacy = "";
  let reviewA = "";
  let reviewB = "";
  const saved = (sha: string) => fx.git(app, "for-each-ref", "--format=%(refname)", "--points-at", sha);
  const short = (sha: string) => sha.slice(0, 7);

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-shared.git"));
    // What an older version saved, with no loop in the name.
    fx.git(app, "commit", "-q", "--allow-empty", "-m", "an older version threw this away");
    legacy = fx.git(app, "rev-parse", "HEAD");
    fx.git(app, "update-ref", "refs/ralph/reverted/1758400000-1", legacy);
    // What a loop named "reverted" saves: under the old prefix, and not old.
    fx.git(app, "commit", "-q", "--allow-empty", "-m", "a loop named reverted threw this away");
    fx.git(app, "update-ref", "refs/ralph/reverted/reverted/1758400001-1", "HEAD");
    fx.git(app, "reset", "-q", "--hard", "HEAD~2");
    fx.makeLoop(B, app, { WORKTREE: true, MAX_ITER: 2, REF_KEEP: 0, VERIFY_CMD: "./measure.sh" });
    fx.makeLoop(A, app, { WORKTREE: true, MAX_ITER: 2, REF_KEEP: 1, VERIFY_CMD: "./measure.sh" });
    // The two stubs make the same change with the same message on the same
    // parent, so commits made in one second were one commit: on a fast CI
    // runner b and a shared a SHA, and the checks below read b's ref as a's.
    // The date is pinned so that would happen every time; the author is what
    // tells the two loops' commits apart.
    const as = (who: string) => ({
      env: { GIT_AUTHOR_NAME: who, GIT_AUTHOR_DATE: "1790902711 +0000", GIT_COMMITTER_DATE: "1790902711 +0000" },
    });
    await fx.runLoop(B, fx.stub("stub-shared-b", ["commit-bad", "commit-bad"]), as("loop b"));
    await fx.runLoop(A, fx.stub("stub-shared-a", ["commit-bad", "commit-bad"]), as("loop a"));
    aShas = rows(A).map((r) => r[3] ?? "");
    bShas = rows(B).map((r) => r[3] ?? "");
    reviewA = fx.cli(home, ["review", "a"]).out;
    reviewB = fx.cli(home, ["review", "b"]).out;
  });

  test("both loops reverted both of their commits, so the checks below mean something", () => {
    expect(statuses(A)).toBe("revert:verify revert:verify");
    expect(statuses(B)).toBe("revert:verify revert:verify");
    expect(new Set([...aShas, ...bShas, ""]).size).toBe(5);
  });
  test("a loop that keeps every ref still has them after another loop pruned its own", () => {
    for (const sha of bShas) expect(saved(sha)).not.toBe("");
  });
  test("each loop's refs carry its name", () => {
    for (const sha of bShas) expect(saved(sha)).toStartWith("refs/ralph/b/reverted/");
    expect(saved(aShas[1]!)).toStartWith("refs/ralph/a/reverted/");
  });
  test("the pruning loop kept its own newest REF_KEEP and let go of the rest", () => {
    expect(saved(aShas[0]!)).toBe("");
    expect(saved(aShas[1]!)).not.toBe("");
  });
  test("a ref an older version saved is not pruned, since no loop can tell it is its own", () => {
    expect(saved(legacy)).toBe("refs/ralph/reverted/1758400000-1");
  });
  test("review lists a loop's own thrown-away commits and not the other loop's", () => {
    expect(reviewA).toContain(short(aShas[1]!));
    for (const sha of bShas) expect(reviewA).not.toContain(short(sha));
    for (const sha of bShas) expect(reviewB).toContain(short(sha));
    for (const sha of aShas) expect(reviewB).not.toContain(short(sha));
  });
  test("review lists an older version's refs under a heading of their own", () => {
    for (const review of [reviewA, reviewB]) {
      const at = review.indexOf("older version");
      expect(at).toBeGreaterThan(review.indexOf("Reverted or dropped"));
      expect(review.slice(at)).toContain("an older version threw this away");
      expect(review).not.toContain("a loop named reverted");
    }
  });
});

describe("the harness's own errors reach the log a human is told to read", () => {
  // Everything the harness starts is redirected into ralph.log by hand, but the
  // git it runs in passing wrote to the inherited stderr, which `ralph start`
  // points at ralph.out. LOG_MAX_BYTES is small so the log rotates before the
  // failing iteration: a descriptor opened once at start follows the renamed
  // file, which is exactly the bug ralph.out has.
  const app = fx.p("app-err");
  const home = fx.p("home-err");
  const D = join(home, "err");
  let logOut = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-err.git"));
    const S = fx.stub("stub-err", ["nothing", "branch-collision"]);
    fx.makeLoop(D, app, { WORKTREE: true, MAX_ITER: 2, LOG_MAX_BYTES: 200, LOG_KEEP: 3 });
    await fx.runLoop(D, S, { env: { RALPH_HOME: home } });
    logOut = fx.cli(home, ["log", "err", "60"]).out;
  });

  test("the loop gave up and asked for a human", () => {
    expect(read(join(D, "ralph.log"))).toContain("fix the worktree by hand");
  });
  test("the log rotated first, so the check below means something", () => {
    expect(existsSync(join(D, "ralph.log.1"))).toBe(true);
  });
  test("git's reason is in the log, not only in ralph.out", () => {
    expect(read(join(D, "ralph.log"))).toContain("cannot lock ref");
  });
  test("ralph log shows it", () => {
    expect(logOut).toContain("cannot lock ref");
  });
});

describe("ralph.out, which nothing rotates, is not a second copy of the log", () => {
  // Every line the loop logs goes to stdout as well, so a loop run by hand in a
  // terminal hears it, and `ralph start` pointed that stdout at ralph.out. So
  // ralph.out held ralph.log over again, and nothing rotates it or removes it:
  // ten iterations whose VERIFY_CMD ended on a 200 KB line (a JSON reporter
  // prints its whole report as one) left ralph.log near its limit and 2,003,804
  // bytes in ralph.out, growing by every iteration's verdict for as long as the
  // loop ran. What bun prints of its own accord, a crash, is in no log, so that
  // still goes to ralph.out.
  const home = fx.p("home-out");
  const D = join(home, "out");
  const C = join(home, "crash");
  const big = 50_000;
  let started = "";
  let out = "";
  let crashOut = "";

  /** `ralph start`, what it said, and the PID it said it started. */
  function start(name: string, stub: string): { said: string; pid: number } {
    const said = fx.cli(home, ["start", name], { STUB_DIR: stub }).out;
    return { said, pid: Number(/as PID (\d+)/.exec(said)?.[1]) };
  }

  setup(async () => {
    fx.makeRepo(fx.p("app-out"), fx.p("remote-out.git"));
    const S = fx.stub("stub-out", ["commit", "commit", "commit", "commit"]);
    fx.makeLoop(D, fx.p("app-out"), {
      WORKTREE: true,
      MAX_ITER: 4,
      LOG_MAX_BYTES: 20000,
      LOG_KEEP: 1,
      VERIFY_CMD: `echo first; head -c ${big} /dev/zero | tr '\\0' x; echo; exit 1`,
    });
    const run = start("out", S);
    started = run.said;
    await until(() => rows(D).length === 4, 120);
    await until(() => !alive(run.pid), 30);
    out = read(join(D, "ralph.out"));

    if (IS_WIN) return;
    fx.makeRepo(fx.p("app-crash"), fx.p("remote-crash.git"));
    fx.makeLoop(C, fx.p("app-crash"), { MAX_ITER: 3, QUIET_SLEEP: 600 });
    // One quiet iteration, then the loop sleeps with no child of its own.
    const crash = start("crash", fx.stub("stub-crash", ["nothing"])).pid;
    await until(() => rows(C).length === 1, 60);
    process.kill(crash, "SIGSEGV");
    await until(() => !alive(crash), 30);
    crashOut = read(join(C, "ralph.out"));
  });

  test("the loop ran under ralph start, and verify failed every iteration", () => {
    expect(started).toContain("started out as PID");
    expect(rows(D).map((r) => r[4])).toEqual(["revert:verify", "revert:verify", "revert:verify", "revert:verify"]);
  });
  test("the log has what the loop said", () => {
    expect(allLogs(D)).toContain("verify exited 1");
  });
  test("ralph.out holds no line of the log", () => {
    expect(out).not.toContain("=== iteration");
    expect(out).not.toContain("verify exited");
  });
  test("ralph.out stays small however long the loop runs", () => {
    expect(out.length).toBeLessThan(1000);
  });
  test.skipIf(IS_WIN)("what bun prints when the loop crashes still lands in ralph.out", () => {
    expect(crashOut).toContain("Bun");
  });
});
