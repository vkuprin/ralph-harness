import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { count, Fx, join, lines, mkNotifier, read, setup, sq, statuses } from "../helpers/index.ts";

const fx = new Fx("pr");

/** The notifier log's rows for one event. */
function rowsOf(log: string, event: string): string[] {
  return lines(log).filter((l) => l.startsWith(`${event}\t`));
}

describe("PUSH=pr: the harness pushes a branch and a human merges the pull request", () => {
  // PUSH=pr pushes ralph/<name> and keeps one pull request open, and nothing
  // pushes main. The gh on PATH is tests/stub/gh, for the whole suite.
  const loop = fx.p("loops/pr");
  const R = fx.p("remote-pr.git");
  const notes = fx.p("notify-pr.log");
  let S = "";
  let review = "";

  // A squash merge puts the loop's changes on main as one new commit and GitHub
  // deletes the branch; then a human pushes onto the branch, and the loop must
  // not overwrite it.
  const loop2 = fx.p("loops/pr2");
  const R2 = fx.p("remote-pr2.git");
  const notes2 = fx.p("notify-pr2.log");
  let S2 = "";

  // gh missing or logged out: the branch is still pushed.
  const loop3 = fx.p("loops/pr3");
  const R3 = fx.p("remote-pr3.git");
  let S3 = "";

  setup(async () => {
    fx.makeRepo(fx.p("app-pr"), R);
    S = fx.stub("stub-pr", ["commit", "push-attempt", "human-main", "conflict", "nothing"]);
    mkNotifier(notes, fx.p("notify-pr.sh"));
    fx.makeLoop(loop, fx.p("app-pr"), {
      WORKTREE: true,
      PUSH: "pr",
      MAX_ITER: 5,
      VERIFY_CMD: "./measure.sh",
      NOTIFY_CMD: sq(fx.p("notify-pr.sh")),
    });
    await fx.runLoop(loop, S, { remote: R });
    review = fx.cli(fx.p("loops"), ["review", "pr"]).out;

    fx.makeRepo(fx.p("app-pr2"), R2);
    S2 = fx.stub("stub-pr2", ["commit", "commit", "squash", "foreign"]);
    mkNotifier(notes2, fx.p("notify-pr2.sh"));
    fx.makeLoop(loop2, fx.p("app-pr2"), {
      WORKTREE: true,
      PUSH: "pr",
      MAX_ITER: 4,
      VERIFY_CMD: "./measure.sh",
      NOTIFY_CMD: sq(fx.p("notify-pr2.sh")),
    });
    await fx.runLoop(loop2, S2, { remote: R2 });

    fx.makeRepo(fx.p("app-pr3"), R3);
    S3 = fx.stub("stub-pr3", ["commit"]);
    writeFileSync(join(S3, "gh-auth-fail"), "");
    fx.makeLoop(loop3, fx.p("app-pr3"), { WORKTREE: true, PUSH: "pr", MAX_ITER: 1 });
    await fx.runLoop(loop3, S3, { remote: R3 });
  });

  test("every commit was kept", () => {
    expect(statuses(loop)).toBe("keep keep keep keep quiet");
  });
  test("the agent is told a human merges its pull request", () => {
    expect(read(join(S, "prompt.agent.1"))).toContain("a human merges its pull request");
  });
  test("without PR_MERGE nothing reads the checks or merges", () => {
    expect(read(join(S, "gh.calls"))).not.toMatch(/^pr (view|merge)/m);
    expect(read(join(S2, "gh.calls"))).not.toMatch(/^pr (view|merge)/m);
  });
  test("the branch is on origin", () => {
    expect(fx.gitOk(R, "rev-parse", "-q", "--verify", "refs/heads/ralph/pr")).toBe(true);
  });
  test("and main never got a commit of the loop's", () => {
    expect(fx.git(R, "log", "main", "--format=%s")).not.toMatch(/^stub:/m);
  });
  test("the agent's own push failed", () => {
    expect(read(join(S, "push-attempt.rc")).trim()).not.toBe("0");
  });
  test("one pull request, however many keeps", () => {
    expect(read(join(S, "gh-created")).trim()).toBe("1");
  });
  test("and the human hears about it with its URL", () => {
    expect(rowsOf(notes, "pr").join("\n")).toContain("example.invalid/pull/1");
  });
  test("a human's push to main is rebased under the branch", () => {
    expect(fx.git(R, "log", "ralph/pr", "--format=%s")).toContain("human: add human.txt");
  });
  test("a conflicting one drops nothing: the commit is on the branch", () => {
    expect(fx.git(R, "log", "ralph/pr", "--format=%s")).toContain("stub: conflicting");
  });
  test("and no drop row is written", () => {
    expect(read(join(loop, "results.tsv"))).not.toContain("drop:");
  });
  test("the human hears about the conflict once, not every sync", () => {
    expect(count(read(notes), /^pr-blocked/)).toBe(1);
  });
  test("ralph review says where the work goes", () => {
    expect(review).toContain("pull request into main");
  });

  test("every commit was kept", () => {
    expect(statuses(loop2)).toBe("keep keep keep keep");
  });
  test("after a squash merge only the later commit is replayed", () => {
    const l = fx.git(R2, "log", "ralph/pr2", "--format=%s");
    expect(l).toContain("human: squash-merge");
    expect(l).toContain("agent call 3");
    expect(l).not.toContain("agent call 1");
  });
  test("onto a branch GitHub deleted, and a new pull request is opened", () => {
    expect(read(join(S2, "gh-created")).trim()).toBe("2");
  });
  test("a commit someone else pushed to the branch is not overwritten", () => {
    expect(fx.git(R2, "rev-parse", "ralph/pr2")).toBe(read(join(S2, "foreign.sha")).trim());
  });
  test("the loop's own commit stays local", () => {
    expect(fx.git(fx.p("app-pr2-ralph-pr2"), "log", "--format=%s")).toContain("agent call 4");
  });
  test("the human hears about the foreign push, and about nothing else blocking", () => {
    const blocked = rowsOf(notes2, "pr-blocked");
    expect(count(read(notes2), /^pr-blocked/)).toBe(1);
    expect(blocked.join("\n")).toContain("did not push");
  });

  test("without a logged-in gh the log says to open it by hand", () => {
    expect(read(join(loop3, "ralph.log"))).toContain("open its pull request by hand");
  });
  test("the branch is pushed anyway", () => {
    expect(fx.gitOk(R3, "rev-parse", "-q", "--verify", "refs/heads/ralph/pr3")).toBe(true);
  });
  test("and no pull request is attempted", () => {
    expect(read(join(S3, "gh.calls"))).not.toContain("pr create");
  });
});
