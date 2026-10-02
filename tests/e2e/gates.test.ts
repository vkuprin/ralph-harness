import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Fx, IS_WIN, count, join, read, rows, setup, sleeperGone, sq, statuses } from "../helpers/index.ts";

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
  test("dropped commit saved under refs/ralph/a/dropped/", () => {
    expect(fx.git(W, "for-each-ref", "refs/ralph/a/dropped/")).not.toBe("");
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
  test("reverted commits are kept under refs/ralph/a/reverted/", () => {
    expect(count(fx.git(W, "for-each-ref", "refs/ralph/a/reverted/"), /./)).toBeGreaterThanOrEqual(4);
  });
  test("review shows what shipped", () => {
    expect(review).toContain("stub: work (agent call 1)");
  });
  test("review shows what the gates threw away", () => {
    expect(review.slice(review.indexOf("Reverted or dropped"))).toContain("stub: bad");
  });
});

describe("the user's own GIT_CONFIG_* settings reach the agent while the harness pushes", () => {
  // The harness adds its push block to the agent's environment as a
  // GIT_CONFIG_KEY_n. Written at index 0 with a count of 1, it dropped every
  // setting the user's environment gave that way: here a core.hooksPath whose
  // pre-commit hook records itself, and a second key that hook reads, so a
  // block written over index 1 shows too.
  for (const push of [true, "pr"] as const) {
    const tag = push === true ? "main" : "pr";
    const app = fx.p(`app-env-${tag}`);
    const remote = fx.p(`remote-env-${tag}.git`);
    const loop = fx.p(`loops/env-${tag}`);
    const hooks = fx.p(`hooks-env-${tag}`);
    const ran = fx.p(`hook-ran-${tag}`);
    let S = "";

    setup(async () => {
      fx.makeRepo(app, remote);
      mkdirSync(hooks);
      writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\necho "hook $(git config --get ralphprobe.marker)" >> ${sq(ran)}\n`);
      chmodSync(join(hooks, "pre-commit"), 0o755);
      S = fx.stub(`stub-env-${tag}`, ["push-attempt"]);
      fx.makeLoop(loop, app, { WORKTREE: true, PUSH: push, PUSH_CONFIRM: "main", MAX_ITER: 1 });
      await fx.runLoop(loop, S, {
        remote,
        env: {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "core.hooksPath",
          GIT_CONFIG_VALUE_0: hooks,
          GIT_CONFIG_KEY_1: "ralphprobe.marker",
          GIT_CONFIG_VALUE_1: "seen",
        },
      });
    });

    test(`PUSH ${tag}: the commit is kept`, () => {
      expect(statuses(loop)).toBe("keep");
    });
    test(`PUSH ${tag}: the user's hook ran for the agent's commit, and read the user's second setting`, () => {
      // Twice: the agent's commit in the worktree, and its probe commit in a
      // repository of its own.
      expect(read(ran)).toBe("hook seen\nhook seen\n");
    });
    test(`PUSH ${tag}: the agent's own push to origin still failed`, () => {
      expect(read(join(S, "push-attempt.rc")).trim()).not.toBe("0");
    });
    test(`PUSH ${tag}: the agent can still push in a repository of its own`, () => {
      expect(read(join(S, "push-other.rc")).trim()).toBe("0");
    });
  }
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

describe("a coloured VERIFY_CMD reaches every reader as plain text", () => {
  // What bun test prints when it fails: a coloured line, here with a tab in it,
  // and after it a line that only resets the colour.
  const app = fx.p("app-colour");
  const loop = fx.p("loops/colour");
  const said = fx.p("notified-colour");
  const why = "verify exited 1: (fail) one thing";
  let S = "";
  let results = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-colour.git"));
    S = fx.stub("stub-colour", ["commit", "commit"]);
    const notifier = fx.p("notify-colour.sh");
    writeFileSync(notifier, `#!/usr/bin/env bash\nprintf '%s=%s\\n' "$RALPH_EVENT" "$RALPH_MESSAGE" >> ${sq(said)}\n`);
    chmodSync(notifier, 0o755);
    fx.makeLoop(loop, app, {
      WORKTREE: true,
      MAX_ITER: 2,
      ESCALATE_AFTER: 2,
      NOTIFY_CMD: sq(notifier),
      VERIFY_CMD: `printf 'ok\\n\\033[31m(fail) one\\tthing\\033[0m\\n\\033[0m\\n'; exit 1`,
    });
    await fx.runLoop(loop, S);
    results = fx.cli(fx.p("loops"), ["results", "colour"]).out;
  });

  test("both iterations failed verify", () => {
    expect(statuses(loop)).toBe("revert:verify revert:verify");
  });
  test("results.tsv holds the failing line, not its colour codes or the reset after it", () => {
    expect(rows(loop).map((r) => r[6])).toEqual([why, why]);
  });
  test("ralph results prints no escape codes", () => {
    expect(results).toContain(why);
    expect(results).not.toContain("\x1b");
  });
  test("the stuck notification carries it without escapes or a tab", () => {
    const stuck = read(said)
      .split("\n")
      .filter((l) => l.startsWith("stuck="));
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toEndWith(`— ${why}`);
  });
  test("the log's own lines carry it without escapes or a tab", () => {
    const lines = read(join(loop, "ralph.log"))
      .split("\n")
      .filter((l) => l.includes("reverted to"));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toEndWith(`: revert:verify — ${why}`);
  });
  test("the next prompt holds no escape codes, and the output's own tab is kept", () => {
    const prompt = read(join(S, "prompt.agent.2"));
    expect(prompt).toContain(`\trevert:verify\t`);
    expect(prompt).toContain(why);
    expect(prompt).toContain("(fail) one\tthing");
    expect(prompt).not.toContain("\x1b");
  });
});

describe("a gate whose git command fails does not read as a pass", () => {
  // The frozen-file check read the stdout of `git diff --name-only` and dropped
  // its exit status, and the reviewer was handed whatever `git log` and `git
  // diff` printed. An agent that sets diff.renames to a word git does not know
  // makes both refuse, with nothing on stdout, while rev-parse, merge-base and
  // reset carry on. Measured before the fix: the commit that edited the frozen
  // measure.sh was kept, and the reviewer accepted an empty diff.
  const app = fx.p("app-nodiff");
  const loop = fx.p("loops/nodiff");
  const W = fx.p("app-nodiff-ralph-nodiff");
  const rapp = fx.p("app-nodiff-review");
  const rloop = fx.p("loops/nodiff-review");
  let S = "";
  let R = "";
  let before = "";
  let restart = { code: -1, out: "", err: "" };

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-nodiff.git"));
    S = fx.stub("stub-nodiff", ["break-diff", "commit"]);
    fx.makeLoop(loop, app, { WORKTREE: true, MAX_ITER: 2, VERIFY_CMD: "./measure.sh", FROZEN: ["measure.sh"] });
    before = fx.git(app, "rev-parse", "HEAD");
    await fx.runLoop(loop, S);
    restart = fx.cli(join(T, "loops"), ["start", "nodiff"], { STUB_DIR: S });

    fx.makeRepo(rapp, fx.p("remote-nodiff-review.git"));
    R = fx.stub("stub-nodiff-review", ["break-diff"], ["ACCEPT"]);
    fx.makeLoop(rloop, rapp, { WORKTREE: true, MAX_ITER: 1, REVIEW: true, VERIFY_CMD: "./measure.sh" });
    await fx.runLoop(rloop, R);
  });

  test("the commit that edited the frozen file is reset, not kept", () => {
    expect(statuses(loop)).toBe("revert:frozen");
    expect(fx.git(W, "rev-parse", "HEAD")).toBe(before);
    expect(read(join(W, "measure.sh"))).not.toContain("# edited");
  });
  test("the verdict says the frozen files could not be checked", () => {
    expect(rows(loop)[0]![6]).toContain("could not check the frozen files: git diff exited 128");
  });
  test("the loop stops rather than pay for an agent the same check would reset", () => {
    expect(read(join(S, "agent_calls")).trim()).toBe("1");
    expect(read(join(loop, "ralph.log"))).toContain("stopping: the frozen-file check could not run");
  });
  test("the reset commit is saved under the loop's refs", () => {
    expect(fx.git(W, "for-each-ref", "refs/ralph/nodiff/reverted/")).not.toBe("");
  });
  test("and the next start refuses, saying the check cannot run", () => {
    expect(restart.code).not.toBe(0);
    expect(restart.err).toContain("the frozen-file check cannot run");
    expect(read(join(S, "agent_calls")).trim()).toBe("1");
  });
  test("the reviewer is not asked to judge a diff git could not show", () => {
    expect(read(join(R, "review_calls"))).toBe("");
    expect(statuses(rloop)).toBe("keep:unreviewed");
    expect(rows(rloop)[0]![6]).toContain("git could not show the commits");
  });
});

describe.skipIf(IS_WIN)("a worktree git could not clean is not judged", () => {
  // The gates run on the files on disk, after a reset and a clean whose exit
  // statuses were dropped. Measured before the fix: an agent committed BAD,
  // which measure.sh fails on, edited measure.sh to pass without committing
  // it, and made the worktree read-only. The reset exited 128, measure.sh ran
  // as edited, and the commit was kept. Windows lets a file in a read-only
  // directory be removed, so neither case can be set up there.
  const app = fx.p("app-locked");
  const loop = fx.p("loops/locked");
  const W = fx.p("app-locked-ralph-locked");
  const app2 = fx.p("app-locked-out");
  const loop2 = fx.p("loops/locked-out");
  const W2 = fx.p("app-locked-out-ralph-locked-out");
  let S = "";
  let S2 = "";
  let before = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-locked.git"));
    S = fx.stub("stub-locked", ["cheat-locked", "commit"]);
    fx.makeLoop(loop, app, { WORKTREE: true, MAX_ITER: 2, VERIFY_CMD: "./measure.sh", FROZEN: ["measure.sh"] });
    before = fx.git(app, "rev-parse", "HEAD");
    await fx.runLoop(loop, S);
    chmodSync(W, 0o755);

    // What VERIFY_CMD leaves behind is cleaned before the next agent, and a
    // directory it cannot be removed from is found there, before an agent.
    fx.makeRepo(app2, fx.p("remote-locked-out.git"));
    S2 = fx.stub("stub-locked-out", ["commit", "commit"]);
    fx.makeLoop(loop2, app2, { WORKTREE: true, MAX_ITER: 2, VERIFY_CMD: "./measure.sh && mkdir out && touch out/x && chmod a-w out" });
    await fx.runLoop(loop2, S2);
    chmodSync(join(W2, "out"), 0o755);
  });

  test("the commit is neither kept nor marked judged, so a restart sets it aside", () => {
    expect(statuses(loop)).toBe("revert:unclean");
    expect(read(join(loop, "ralph.log"))).not.toContain("shipped");
    expect(read(join(loop, ".gated-head")).trim()).toBe(before);
  });
  test("the verdict quotes git", () => {
    expect(rows(loop)[0]![6]).toContain("could not clean the worktree: git reset exited 128");
  });
  test("the loop stops, since the reset back cannot be written either", () => {
    expect(read(join(S, "agent_calls")).trim()).toBe("1");
    expect(read(join(loop, "ralph.log"))).toContain(`stopping: could not reset ralph/locked to ${before} after revert:unclean`);
  });
  test("a tree left unclean between iterations stops the loop before the next agent", () => {
    expect(statuses(loop2)).toBe("keep");
    expect(read(join(S2, "agent_calls")).trim()).toBe("1");
    const log = read(join(loop2, "ralph.log"));
    expect(log).toContain("stopping: could not clean the worktree before iteration 2 (git clean exited 1");
    expect(log).toContain("ralph finished after 1 iterations");
  });
});

describe("git looks at the files itself when it cleans the worktree", () => {
  // Measured before the fix: an agent committed BAD, edited measure.sh to pass
  // without committing it, and configured an fsmonitor hook that answers
  // "nothing changed". The reset believed it, left the edit, and the commit
  // was kept. A repository the agent left inside the worktree, such as a
  // clone it looked at, survived `git clean -fd` and failed the verify of
  // the commit that left it, which was fine.
  const app = fx.p("app-fsmon");
  const loop = fx.p("loops/fsmon");
  const app2 = fx.p("app-nest");
  const loop2 = fx.p("loops/nest");
  const W2 = fx.p("app-nest-ralph-nest");
  let S = "";
  let S2 = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-fsmon.git"));
    S = fx.stub("stub-fsmon", ["cheat-fsmonitor"]);
    fx.makeLoop(loop, app, { WORKTREE: true, MAX_ITER: 1, VERIFY_CMD: "./measure.sh", FROZEN: ["measure.sh"] });
    await fx.runLoop(loop, S);

    fx.makeRepo(app2, fx.p("remote-nest.git"));
    S2 = fx.stub("stub-nest", ["nest", "commit"]);
    fx.makeLoop(loop2, app2, { WORKTREE: true, MAX_ITER: 2, VERIFY_CMD: "./measure.sh && test ! -e dep" });
    await fx.runLoop(loop2, S2);
  });

  test("an fsmonitor hook that lies does not keep the uncommitted edit", () => {
    expect(statuses(loop)).toBe("revert:verify");
    expect(read(join(S, "agent_calls")).trim()).toBe("1");
  });
  test("a repository left inside the worktree is thrown away like any other file", () => {
    expect(statuses(loop2)).toBe("keep keep");
    expect(existsSync(join(W2, "dep"))).toBe(false);
  });
});

describe("a gate the config names but no gate will run is said at the start", () => {
  // git reads a FROZEN entry as a path, case and all, and every gate runs in
  // the worktree. Measured before the fix: FROZEN "Measure.sh" or "mesure.sh"
  // let a commit that edited measure.sh ship, and so did WORKTREE false with
  // FROZEN, VERIFY_CMD and REVIEW set, where a commit that VERIFY_CMD fails
  // shipped too and the reviewer was never asked. The log said nothing but
  // `verify=yes review=1`, and the agent was told a frozen edit is reset.
  const app = fx.p("app-unguarded");
  const loop = fx.p("loops/unguarded");
  const app2 = fx.p("app-nowt");
  const loop2 = fx.p("loops/nowt");
  const app3 = fx.p("app-nogates");
  const loop3 = fx.p("loops/nogates");
  let S = "";
  let S2 = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-unguarded.git"));
    mkdirSync(join(app, "eval"));
    writeFileSync(join(app, "eval", "cases.txt"), "one\n");
    fx.git(app, "add", "-A");
    fx.git(app, "commit", "-qm", "eval cases");
    fx.git(app, "push", "-q", "origin", "main");
    S = fx.stub("stub-unguarded", ["touch-frozen"]);
    fx.makeLoop(loop, app, { WORKTREE: true, MAX_ITER: 1, FROZEN: ["Measure.sh", "mesure.sh", "eval"] });
    await fx.runLoop(loop, S);

    fx.makeRepo(app2, fx.p("remote-nowt.git"));
    S2 = fx.stub("stub-nowt", ["touch-frozen", "commit-bad"], ["REJECT: no", "REJECT: no"]);
    fx.makeLoop(loop2, app2, { WORKTREE: false, MAX_ITER: 2, FROZEN: ["measure.sh"], VERIFY_CMD: "./measure.sh", REVIEW: true });
    await fx.runLoop(loop2, S2);

    fx.makeRepo(app3, fx.p("remote-nogates.git"));
    fx.makeLoop(loop3, app3, { WORKTREE: false, MAX_ITER: 1 });
    await fx.runLoop(loop3, fx.stub("stub-nogates", ["commit"]));
  });

  test("a FROZEN entry in the wrong case is named, with the file git has", () => {
    expect(read(join(loop, "ralph.log"))).toContain(
      `FROZEN: "Measure.sh" matches no file in the worktree, so the frozen-file check stops only a commit that adds one — git compares case, and "measure.sh" is there`,
    );
  });
  test("a FROZEN entry that names nothing is named", () => {
    expect(read(join(loop, "ralph.log"))).toContain(
      `FROZEN: "mesure.sh" matches no file in the worktree, so the frozen-file check stops only a commit that adds one — name a file that is there`,
    );
  });
  test("an entry that names a file is not, and the check itself is unchanged", () => {
    expect(read(join(loop, "ralph.log"))).not.toContain(`FROZEN: "eval"`);
    expect(statuses(loop)).toBe("keep");
  });
  test("without WORKTREE the start says which gates judge nothing", () => {
    expect(statuses(loop2)).toBe("keep keep");
    expect(read(join(loop2, "ralph.log"))).toContain(
      `WORKTREE false: VERIFY_CMD, REVIEW, FROZEN judge nothing — every gate runs in the worktree`,
    );
  });
  test("and the agent is not told that a frozen edit is reset", () => {
    const prompt = read(join(S2, "prompt.agent.1"));
    expect(prompt).toContain("Frozen, never edit: measure.sh.");
    expect(prompt).not.toContain("A commit that touches any of them is reset");
    expect(read(join(S, "prompt.agent.1"))).toContain("A commit that touches any of them is reset");
  });
  test("a loop without WORKTREE that names no gate hears nothing about them", () => {
    expect(read(join(loop3, "ralph.log"))).not.toContain("judge nothing");
  });
});
