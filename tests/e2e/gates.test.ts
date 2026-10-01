import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Fx, IS_WIN, count, join, read, rows, setup, sleeperGone, statuses } from "../helpers/index.ts";

const fx = new Fx("gates");
const T = fx.T;

describe("gates, verdicts and pushes (WORKTREE=1 PUSH=1 REVIEW=1)", () => {
  const app = fx.p("app");
  const remote = fx.p("remote.git");
  const loop = fx.p("loops/a");
  const W = fx.p("app-ralph-a");
  let S = "";
  let appHead = "";
  let remoteLog = "";
  let review = "";

  setup(async () => {
    fx.makeRepo(app, remote);
    S = fx.stub(
      "stub-a",
      ["commit", "commit-bad", "touch-frozen", "commit", "sleep", "limit", "fail", "nothing", "cheat", "push-attempt", "conflict"],
      ["ACCEPT", "REJECT: not what the job asks for", "ACCEPT", "ACCEPT"],
    );
    fx.makeLoop(loop, app, {
      WORKTREE: true,
      PUSH: true,
      PUSH_CONFIRM: "main",
      REVIEW: true,
      // Long enough for an agent that runs git eight times, which on a Windows
      // runner, at a few hundred ms a process, took more than 3s.
      ITER_TIMEOUT: IS_WIN ? 15 : 3,
      MAX_ITER: 10,
      VERIFY_CMD: `env > '${loop}/verify-env'; ./measure.sh`,
      FROZEN: ["measure.sh"],
    });
    appHead = fx.git(app, "rev-parse", "HEAD");
    await fx.runLoop(loop, S, { remote });
    remoteLog = fx.git(remote, "log", "--format=%s", "main");
    review = fx.cli(join(T, "loops"), ["review", "a"]).out;
  });

  test("verdicts in order", () => {
    expect(statuses(loop)).toBe(
      "keep revert:verify revert:frozen revert:review timeout ratelimit error quiet revert:verify keep keep drop:conflict",
    );
  });
  test("worktree created next to the repo", () => {
    expect(existsSync(W)).toBe(true);
  });
  test("first kept commit reached origin", () => {
    expect(remoteLog).toContain("stub: work (agent call 1)");
  });
  test("commit kept after the agent's own push attempt reached origin", () => {
    expect(remoteLog).toContain("stub: pushed");
  });
  test("rejected commits never reached origin", () => {
    expect(remoteLog).not.toMatch(/stub: (bad|frozen|cheat)|agent call 4/);
  });
  test("human commit survived; conflicting agent commit was dropped", () => {
    expect(remoteLog).toContain("human: edit work.txt");
    expect(remoteLog).not.toContain("stub: conflicting");
  });
  test("dropped commit saved under refs/ralph/dropped/", () => {
    expect(fx.git(W, "for-each-ref", "refs/ralph/dropped/")).not.toBe("");
  });
  test("the agent's own git push failed", () => {
    expect(read(join(S, "push-attempt.rc")).trim()).not.toBe("0");
  });
  test("the agent can still push in an unrelated repository with an origin of its own", () => {
    expect(read(join(S, "push-other.rc")).trim()).toBe("0");
  });
  test("your checkout was never touched", () => {
    expect(fx.git(app, "rev-parse", "HEAD")).toBe(appHead);
  });
  test("your checkout is clean", () => {
    expect(fx.git(app, "status", "--porcelain")).toBe("");
  });
  test("worktree is clean after the run", () => {
    expect(fx.git(W, "status", "--porcelain")).toBe("");
  });
  test("uncommitted edit to the frozen file was discarded", () => {
    expect(read(join(W, "measure.sh"))).toContain("test ! -f BAD");
  });
  test("the prompt tells the agent not to push", () => {
    expect(read(join(S, "prompt.agent.1"))).toContain("do not push");
  });
  test("the prompt lists frozen files", () => {
    expect(read(join(S, "prompt.agent.1"))).toContain("Frozen, never edit: measure.sh");
  });
  test("iteration 2 sees the harness verdicts", () => {
    expect(read(join(S, "prompt.agent.2"))).toContain("# Harness verdicts");
  });
  test("after 3 failures the prompt says pivot", () => {
    expect(read(join(S, "prompt.agent.5"))).toContain("Do not retry that approach");
  });
  test("a quiet iteration clears the escalation", () => {
    expect(read(join(S, "prompt.agent.9"))).not.toContain("Harness: stuck");
  });
  test("the reviewer was only asked about commits that passed verify", () => {
    expect(read(join(S, "review_calls")).trim()).toBe("4");
  });
  test("the reviewer prompt points at the diff file", () => {
    expect(read(join(S, "prompt.review.1"))).toContain("review.diff");
  });
  test("timeout killed the agent's process group", () => {
    expect(sleeperGone(join(S, "sleeper.pid"))).toBe(true);
  });
  test("usage-limit reason recorded", () => {
    expect(read(join(loop, "results.tsv"))).toContain("hit your limit");
  });
  test("no harness variable leaks into the agent's environment", () => {
    expect(read(join(S, "leaked-env"))).toBe("");
  });
  test("no harness variable leaks into VERIFY_CMD", () => {
    expect(read(join(loop, "verify-env"))).not.toMatch(/^BOUNDED_/m);
  });
  test("reverted commits are kept under refs/ralph/reverted/", () => {
    expect(count(fx.git(W, "for-each-ref", "refs/ralph/reverted/"), /./)).toBeGreaterThanOrEqual(4);
  });
  test("review shows what shipped", () => {
    expect(review).toContain("stub: work (agent call 1)");
  });
  test("review shows what the gates threw away", () => {
    expect(review.slice(review.indexOf("Reverted or dropped"))).toContain("stub: bad");
  });
});

describe("escalation and the PROGRESS.md cap", () => {
  const app = fx.p("app-b");
  const remote = fx.p("remote-b.git");
  const loop = fx.p("loops/b");
  let S = "";

  setup(async () => {
    fx.makeRepo(app, remote);
    S = fx.stub("stub-b", ["commit-bad", "commit-bad", "commit-bad", "commit-bad", "commit-bad", "commit-bad", "nothing"]);
    fx.makeLoop(loop, app, { WORKTREE: true, PUSH: true, PUSH_CONFIRM: "main", MAX_ITER: 7, PROGRESS_KEEP: 8, VERIFY_CMD: "./measure.sh" });
    writeFileSync(join(loop, "PROGRESS.md"), seededProgress());
    await fx.runLoop(loop, S, { remote });
  });

  test("six rejected commits in a row then quiet", () => {
    expect(statuses(loop)).toBe("revert:verify revert:verify revert:verify revert:verify revert:verify revert:verify quiet");
  });
  test("after 3 in a row: pivot", () => {
    expect(read(join(S, "prompt.agent.4"))).toContain("Do not retry that approach");
  });
  test("after 6 in a row: hand it to a human", () => {
    const p = read(join(S, "prompt.agent.7"));
    expect(p.slice(p.indexOf("Harness: stuck"))).toContain("Needs a decision");
  });
  test("PROGRESS.md keeps 8 Log entries", () => {
    expect(count(read(join(loop, "PROGRESS.md")), /^### /)).toBe(8);
  });
  test("PROGRESS.md keeps the newest entries", () => {
    expect(read(join(loop, "PROGRESS.md"))).toMatch(/iteration 12$/m);
  });
  test("PROGRESS.md keeps its head sections", () => {
    expect(read(join(loop, "PROGRESS.md"))).toMatch(/^## Needs a decision/m);
  });
  test("archive holds the 4 oldest entries, oldest first", () => {
    const order = read(join(loop, "PROGRESS-archive.md"))
      .split("\n")
      .filter((l) => l.startsWith("### "))
      .map((l) => l.replace(/.*iteration /, ""));
    expect(order).toEqual(["1", "2", "3", "4"]);
  });
  test("later prompts point at the archive", () => {
    expect(read(join(S, "prompt.agent.2"))).toContain("PROGRESS-archive.md");
  });
  test("nothing reached origin", () => {
    expect(fx.git(remote, "rev-list", "--count", "main")).toBe("1");
  });
});

describe("old-style loop (WORKTREE=0, every new setting left at its default)", () => {
  const app = fx.p("app-c");
  const remote = fx.p("remote-c.git");
  const loop = fx.p("loops/c");
  let before = "";

  setup(async () => {
    fx.makeRepo(app, remote);
    const S = fx.stub("stub-c", ["commit", "nothing"]);
    fx.makeLoop(loop, app, { MAX_ITER: 2 });
    before = fx.git(app, "rev-parse", "HEAD");
    await fx.runLoop(loop, S, { remote });
  });

  test("keep then quiet", () => {
    expect(statuses(loop)).toBe("keep quiet");
  });
  test("the agent committed straight into the checkout", () => {
    expect(fx.git(app, "rev-list", "--count", `${before}..HEAD`)).toBe("1");
  });
  test("no worktree was made", () => {
    expect(existsSync(fx.p("app-c-ralph-c"))).toBe(false);
  });
  test("nothing was pushed", () => {
    expect(fx.git(remote, "rev-list", "--count", "main")).toBe("1");
  });
  test("empty FROZEN=() did not break set -u", () => {
    expect(read(join(loop, "ralph.out")) + read(join(loop, "ralph.log"))).not.toContain("unbound variable");
  });
});

/** Twelve Log entries under the template's head sections, newest first. */
export function seededProgress(): string {
  const tpl = readFileSync(join(import.meta.dir, "../../template/PROGRESS.md"), "utf8");
  let out = `${tpl.slice(0, tpl.indexOf("## Log"))}## Log\n\n`;
  for (let i = 12; i >= 1; i--) {
    out += `### 2026-01-${String(i).padStart(2, "0")} 10:00 — iteration ${i}\n\nentry ${i}\n\n`;
  }
  return out;
}
describe("the reviewer and the agent are told what the gate already checked", () => {
  const app = fx.p("app-told");
  const loop = fx.p("loops/told");
  const bare = fx.p("loops/told-bare");
  let S = "";
  let B = "";
  let failed: string[] = [];

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-told.git"));
    S = fx.stub("stub-told", ["commit", "commit-bad", "limit", "nothing", "commit"], ["ACCEPT", "ACCEPT"]);
    fx.makeLoop(loop, app, {
      WORKTREE: true,
      REVIEW: true,
      MAX_ITER: 4,
      FROZEN: ["measure.sh"],
      VERIFY_CMD: "./measure.sh || { echo 'measure: BAD is there'; exit 1; }",
    });
    await fx.runLoop(loop, S);
    failed = rows(loop).find((r) => r[4] === "revert:verify") ?? [];

    fx.makeRepo(fx.p("app-told-bare"), fx.p("remote-told-bare.git"));
    B = fx.stub("stub-told-bare", ["commit"], ["ACCEPT"]);
    fx.makeLoop(bare, fx.p("app-told-bare"), { WORKTREE: true, REVIEW: true, MAX_ITER: 1 });
    await fx.runLoop(bare, B);
  });

  test("verdicts in order", () => {
    expect(statuses(loop)).toBe("keep revert:verify ratelimit quiet keep");
  });
  test("review.diff starts with each commit's message, which the reviewer cannot get from git", () => {
    const diff = read(join(loop, "review.diff"));
    expect(diff).toMatch(/^commit [0-9a-f]{40}\n\nstub: work \(agent call 5\)/);
    expect(diff.indexOf("stub: work")).toBeLessThan(diff.indexOf("diff --git"));
  });
  test("the reviewer is told VERIFY_CMD passed, where its output is, and that the frozen files held", () => {
    const prompt = read(join(S, "prompt.review.1"));
    expect(prompt).toContain("VERIFY_CMD passed on these commits");
    expect(prompt).toContain(join(loop, "verify.out"));
    expect(prompt).toContain("None of the frozen files changed: measure.sh");
    expect(prompt).toContain("Do not reject for not having run them");
  });
  test("the reviewer is told not to look for history in the worktree's .git", () => {
    expect(read(join(S, "prompt.review.1"))).toContain("do not look for history there");
  });
  test("without VERIFY_CMD the reviewer is told nothing has run the commits", () => {
    const prompt = read(join(B, "prompt.review.1"));
    expect(prompt).toContain("Nothing has run these commits");
    expect(prompt).not.toContain("VERIFY_CMD passed");
  });
  test("the agent is told the harness runs VERIFY_CMD, so not to run all of it", () => {
    const prompt = read(join(S, "prompt.agent.1"));
    expect(prompt).toContain("do not run the whole of it yourself");
    expect(prompt).toContain("./measure.sh ||");
    expect(read(join(B, "prompt.agent.1"))).not.toContain("do not run the whole of it");
  });
  test("after VERIFY_CMD fails, the next prompt holds its last lines and how to get the commits back", () => {
    const prompt = read(join(S, "prompt.agent.3"));
    expect(prompt).toContain("# Harness: VERIFY_CMD failed on the last commits");
    expect(prompt).toContain("measure: BAD is there");
    // results.tsv holds the first 12 characters of each sha; the prompt holds all of them.
    expect(prompt).toMatch(new RegExp(`git cherry-pick ${failed[2]}[0-9a-f]{28}\\.\\.${failed[3]}[0-9a-f]{28}\``));
    expect(read(join(S, "prompt.agent.1"))).not.toContain("VERIFY_CMD failed");
  });
  test("that range is the reset commit, still reachable", () => {
    expect(fx.git(fx.p("app-told-ralph-told"), "log", "--format=%s", `${failed[2]}..${failed[3]}`)).toBe("stub: bad (agent call 2)");
  });
  test("a limit judged nothing, so the retry still hears about the failure", () => {
    expect(read(join(S, "prompt.agent.4"))).toContain("VERIFY_CMD failed on the last commits");
  });
  test("an iteration that ran and shipped nothing clears it", () => {
    expect(read(join(S, "prompt.agent.5"))).not.toContain("VERIFY_CMD failed");
  });
});
