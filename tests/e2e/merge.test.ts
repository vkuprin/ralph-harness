import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { Fx, join, lines, mkNotifier, read, setup, sq, statuses, until } from "../helpers/index.ts";

const fx = new Fx("merge");

// The checks `gh pr view` reports, as tests/stub/gh reads them from gh-checks.
const run = (name: string, conclusion: string, status = "COMPLETED") =>
  JSON.stringify({ __typename: "CheckRun", name, status, conclusion });
const PASS = `[${run("test", "SUCCESS")}]`;
const PENDING = `[${run("test", "", "IN_PROGRESS")}]`;

/** The notifier log's messages for one event. */
function said(log: string, event: string): string[] {
  return lines(log)
    .filter((l) => l.startsWith(`${event}\t`))
    .map((l) => l.split("\t")[4] ?? "");
}

function calls(stub: string, what: string): string[] {
  return lines(join(stub, "gh.calls")).filter((l) => l.startsWith(what));
}

interface Case {
  loop: string;
  remote: string;
  stub: string;
  notes: string;
  rc: number;
}

/**
 * One loop on a fresh repository with PUSH "pr" and PR_MERGE: it keeps one
 * commit per mode and ends at MAX_ITER, which is when it merges. `checks` are
 * gh-checks lines; `files` go into the stub directory as they are.
 */
async function merging(
  name: string,
  opts: { modes?: string[]; checks?: string[]; files?: Record<string, string>; cfg?: Record<string, unknown> } = {},
): Promise<Case> {
  const modes = opts.modes ?? ["commit"];
  const c: Case = {
    loop: fx.p(`loops/${name}`),
    remote: fx.p(`remote-${name}.git`),
    stub: fx.stub(`stub-${name}`, modes),
    notes: fx.p(`notify-${name}.log`),
    rc: -1,
  };
  fx.makeRepo(fx.p(`app-${name}`), c.remote);
  if (opts.checks) writeFileSync(join(c.stub, "gh-checks"), opts.checks.map((l) => `${l}\n`).join(""));
  for (const [f, text] of Object.entries(opts.files ?? {})) writeFileSync(join(c.stub, f), text);
  mkNotifier(c.notes, fx.p(`notify-${name}.sh`));
  fx.makeLoop(c.loop, fx.p(`app-${name}`), {
    WORKTREE: true,
    PUSH: "pr",
    PR_MERGE: true,
    PR_MERGE_POLL: 1,
    PR_MERGE_WAIT: 20,
    MAX_ITER: modes.length,
    VERIFY_CMD: "./measure.sh",
    NOTIFY_CMD: sq(fx.p(`notify-${name}.sh`)),
    ...opts.cfg,
  });
  c.rc = await fx.runLoop(c.loop, c.stub, { remote: c.remote });
  return c;
}

describe("PR_MERGE: the harness merges the pull request when the loop ends", () => {
  let pass: Case;
  let slow: Case;
  let failing: Case;
  let bare: Case;
  let untested: Case;
  let refused: Case;
  let forever: Case;
  let behind: Case;
  let review = "";

  setup(async () => {
    pass = await merging("pass", { checks: [PASS] });
    review = fx.cli(fx.p("loops"), ["review", "pass"]).out;
    slow = await merging("slow", { checks: [PENDING, PENDING, PASS], cfg: { PR_MERGE_METHOD: "squash" } });
    failing = await merging("failing", { checks: [`[${run("lint", "FAILURE")},${run("test", "SUCCESS")}]`] });
    bare = await merging("bare");
    untested = await merging("untested", { cfg: { VERIFY_CMD: "" } });
    refused = await merging("refused", {
      checks: [PASS],
      files: { "gh-merge-fail": "Pull request is not mergeable: the base branch policy prohibits the merge.\n" },
    });
    forever = await merging("forever", { checks: [PENDING], cfg: { PR_MERGE_WAIT: 2 } });
    // The second iteration conflicts with a commit a human pushed to main, so
    // the branch cannot sit on main: nothing checked it there.
    behind = await merging("behind", { modes: ["commit", "conflict"], checks: [PASS] });
  });

  test("every loop kept its commits and ended cleanly", () => {
    expect(statuses(pass.loop)).toBe("keep");
    expect(statuses(behind.loop)).toBe("keep keep");
    for (const c of [pass, slow, failing, bare, untested, refused, forever, behind]) expect(c.rc).toBe(0);
  });
  test("the agent is told the harness merges when the loop ends", () => {
    expect(read(join(pass.stub, "prompt.agent.1"))).toContain("merges its pull request into main when the loop ends, if every check on it passes");
  });

  test("checks that pass: the head the harness pushed is merged with a merge commit", () => {
    const head = fx.git(pass.remote, "rev-parse", "refs/heads/ralph/pass");
    expect(calls(pass.stub, "pr merge")).toEqual([`pr merge ralph/pass --merge --match-head-commit ${head}`]);
    expect(fx.gitOk(pass.remote, "merge-base", "--is-ancestor", head, "main")).toBe(true);
    expect(fx.git(pass.remote, "log", "-1", "--format=%s", "main")).toBe("Merge pull request from ralph/pass");
  });
  test("and the human hears it was merged, with the URL", () => {
    const m = said(pass.notes, "merged");
    expect(m.length).toBe(1);
    expect(m[0]).toContain("https://example.invalid/pull/1");
    expect(said(pass.notes, "merge-blocked")).toEqual([]);
  });
  test("the one stop notification still comes after it", () => {
    const events = lines(pass.notes).map((l) => l.split("\t")[0]);
    expect(events.indexOf("merged")).toBeLessThan(events.indexOf("stopped"));
  });
  test("ralph review says the harness merges it", () => {
    expect(review).toContain("merges that when the loop ends if its checks pass");
  });

  test("checks still running are waited for, and PR_MERGE_METHOD picks the method", () => {
    expect(calls(slow.stub, "pr view").length).toBe(3);
    expect(calls(slow.stub, "pr merge")[0]).toStartWith("pr merge ralph/slow --squash --match-head-commit ");
    expect(fx.git(slow.remote, "log", "-1", "--format=%s", "main")).toBe("ralph/slow (squashed)");
  });

  test("a failing check blocks the merge and names the check", () => {
    expect(calls(failing.stub, "pr merge")).toEqual([]);
    const m = said(failing.notes, "merge-blocked");
    expect(m.length).toBe(1);
    expect(m[0]).toContain("checks failed");
    expect(m[0]).toContain("lint");
    expect(m[0]).not.toContain("test");
    expect(fx.git(failing.remote, "log", "--format=%s", "main")).not.toMatch(/^stub:/m);
  });

  test("no checks at all: VERIFY_CMD is enough, after a second look", () => {
    expect(calls(bare.stub, "pr view").length).toBe(2);
    expect(said(bare.notes, "merged")[0]).toContain("no CI checks, and VERIFY_CMD passed on every commit");
  });
  test("no checks and no VERIFY_CMD: nothing tested it, so no merge", () => {
    expect(calls(untested.stub, "pr merge")).toEqual([]);
    expect(said(untested.notes, "merge-blocked")[0]).toContain("nothing tested");
  });

  test("GitHub refusing the merge is told, in its own words", () => {
    expect(calls(refused.stub, "pr merge").length).toBe(1);
    expect(said(refused.notes, "merge-blocked")[0]).toContain("the base branch policy prohibits the merge");
    expect(said(refused.notes, "merged")).toEqual([]);
  });

  test("checks that never finish give up after PR_MERGE_WAIT", () => {
    expect(calls(forever.stub, "pr view").length).toBe(3);
    expect(calls(forever.stub, "pr merge")).toEqual([]);
    const m = said(forever.notes, "merge-blocked")[0] ?? "";
    expect(m).toContain("gave up after PR_MERGE_WAIT=2s");
    expect(m).toContain("checks still running: test");
  });

  test("a branch that does not sit on main is not merged, whatever its checks say", () => {
    expect(calls(behind.stub, "pr merge")).toEqual([]);
    expect(said(behind.notes, "merge-blocked")[0]).toContain("does not sit on origin/main");
  });
});

describe("PR_MERGE refuses a config it cannot honour, and a signal never merges", () => {
  let contradiction: Case;
  const home = fx.p("stop-home");
  const loop = join(home, "held");
  const R = fx.p("remote-held.git");
  let S = "";
  let waited = false;
  let gone = false;

  setup(async () => {
    contradiction = await merging("nopr", { cfg: { PUSH: true } });

    fx.makeRepo(fx.p("app-held"), R);
    S = fx.stub("stub-held", ["commit"]);
    writeFileSync(join(S, "gh-checks"), `${PENDING}\n`);
    fx.makeLoop(loop, fx.p("app-held"), {
      WORKTREE: true,
      PUSH: "pr",
      PR_MERGE: true,
      PR_MERGE_POLL: 1,
      PR_MERGE_WAIT: 600,
      MAX_ITER: 1,
      VERIFY_CMD: "./measure.sh",
    });
    fx.cli(home, ["start", "held"], { STUB_DIR: S, STUB_REMOTE: R });
    // Stopped while it waits on checks that never finish.
    waited = await until(() => calls(S, "pr view").length >= 2, 60);
    fx.cli(home, ["stop", "held"]);
    gone = await until(() => !existsSync(join(loop, "ralph.pid")), 30);
  });

  test("PR_MERGE without PUSH \"pr\" refuses the start", () => {
    expect(contradiction.rc).toBe(2);
    expect(read(join(contradiction.loop, "ralph.log"))).toContain('PR_MERGE merges the pull request that PUSH "pr" opens');
    expect(said(contradiction.notes, "refused").length).toBe(1);
    expect(calls(contradiction.stub, "pr ")).toEqual([]);
  });
  test("ralph stop during the wait ends it and merges nothing", () => {
    expect(waited).toBe(true);
    expect(gone).toBe(true);
    expect(calls(S, "pr merge")).toEqual([]);
    expect(fx.git(R, "log", "--format=%s", "main")).not.toMatch(/^stub:/m);
  });
});

/**
 * A LAND_OK_CMD that fails its first `fails` calls, the way a check of
 * production fails while a long job runs there. Every call records what origin
 * holds for main at that moment, one sha per line in `<name>.seen`.
 */
function landScript(name: string, fails: number): { cmd: string; seen: string } {
  const cmd = fx.p(`land-${name}.sh`);
  const n = fx.p(`land-${name}.count`);
  const seen = fx.p(`land-${name}.seen`);
  writeFileSync(
    cmd,
    `#!/bin/sh
n=$(cat ${sq(n)} 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > ${sq(n)}
git ls-remote origin refs/heads/main | cut -f1 >> ${sq(seen)}
if [ "$n" -le ${fails} ]; then echo "ingest_runs: 1 running"; exit 1; fi
`,
  );
  chmodSync(cmd, 0o755);
  return { cmd: sq(cmd), seen };
}

describe("PR_DRAFT: the pull request is a draft until the loop ends by itself", () => {
  let merged: Case;
  let ready: Case;
  const home = fx.p("draft-home");
  const loop = join(home, "stopped");
  const R = fx.p("remote-stopped.git");
  let S = "";
  let sleeping = false;
  let gone = false;

  setup(async () => {
    merged = await merging("draft", { checks: [PASS], cfg: { PR_DRAFT: true } });
    ready = await merging("drafted", { cfg: { PR_DRAFT: true, PR_MERGE: false } });

    fx.makeRepo(fx.p("app-stopped"), R);
    S = fx.stub("stub-stopped", ["commit", "sleep"]);
    fx.makeLoop(loop, fx.p("app-stopped"), { WORKTREE: true, PUSH: "pr", PR_DRAFT: true, MAX_ITER: 2, ITER_TIMEOUT: 600 });
    fx.cli(home, ["start", "stopped"], { STUB_DIR: S, STUB_REMOTE: R });
    sleeping = await until(() => existsSync(join(S, "sleeper.pid")) && calls(S, "pr create").length === 1, 60);
    fx.cli(home, ["stop", "stopped"]);
    gone = await until(() => !existsSync(join(loop, "ralph.pid")), 30);
  });

  test("the pull request is opened as a draft", () => {
    expect(calls(merged.stub, "pr create")[0]).toContain("--draft");
  });
  test("its description says it stays a draft while the loop runs", () => {
    expect(read(join(merged.loop, ".pr-body"))).toContain("stays a draft while the loop runs");
  });
  test("with PR_MERGE it is marked ready before the merge, which GitHub refuses for a draft", () => {
    const gh = lines(join(merged.stub, "gh.calls"));
    const at = gh.findIndex((l) => l.startsWith("pr ready ralph/draft"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(gh.findIndex((l) => l.startsWith("pr merge ralph/draft")));
    expect(said(merged.notes, "merged").length).toBe(1);
    expect(said(merged.notes, "pr-ready")).toEqual([]);
  });
  test("without PR_MERGE it is marked ready and the human hears once", () => {
    expect(calls(ready.stub, "pr ready")).toEqual(["pr ready ralph/drafted"]);
    expect(said(ready.notes, "pr-ready").length).toBe(1);
    expect(calls(ready.stub, "pr merge")).toEqual([]);
  });
  test("ralph stop leaves it a draft: the human who stopped the loop decides", () => {
    expect(sleeping).toBe(true);
    expect(gone).toBe(true);
    expect(calls(S, "pr ready")).toEqual([]);
    expect(existsSync(join(S, "gh-draft"))).toBe(true);
  });
});

describe("LAND_OK_CMD: BRANCH does not move while production is busy", () => {
  let held: Case;
  let merge = { cmd: "", seen: "" };
  let push = { cmd: "", seen: "" };
  const loop = fx.p("loops/landpush");
  const R = fx.p("remote-landpush.git");
  const notes = fx.p("notify-landpush.log");
  let S = "";
  let start = "";

  setup(async () => {
    // A pass, then checks running again, then a pass: the wait for LAND_OK_CMD
    // must not use up PR_MERGE_WAIT, or the pending look in the middle gives up.
    merge = landScript("merge", 1);
    held = await merging("landmerge", {
      checks: [PASS, PENDING, PASS],
      cfg: { LAND_OK_CMD: merge.cmd, ACTIVE_POLL: 1, PR_MERGE_WAIT: 1 },
    });

    push = landScript("push", 2);
    fx.makeRepo(fx.p("app-landpush"), R);
    start = fx.git(R, "rev-parse", "main");
    S = fx.stub("stub-landpush", ["commit", "commit"]);
    mkNotifier(notes, fx.p("notify-landpush.sh"));
    fx.makeLoop(loop, fx.p("app-landpush"), {
      WORKTREE: true,
      PUSH: true,
      PUSH_CONFIRM: "main",
      MAX_ITER: 2,
      LAND_OK_CMD: push.cmd,
      ACTIVE_POLL: 1,
      NOTIFY_CMD: sq(fx.p("notify-landpush.sh")),
    });
    await fx.runLoop(loop, S, { remote: R });
  });

  test("the merge waits for it, then goes through", () => {
    expect(held.rc).toBe(0);
    expect(said(held.notes, "merged").length).toBe(1);
    expect(said(held.notes, "merge-blocked")).toEqual([]);
    expect(read(join(held.loop, "ralph.log"))).toContain("LAND_OK_CMD passes; going on with the merge of ralph/landmerge into main");
  });
  test("the human hears once that the merge is held, with the check's own words", () => {
    const m = said(held.notes, "land-held");
    expect(m.length).toBe(1);
    expect(m[0]).toContain("ingest_runs: 1 running");
  });
  test("the pull request asks whoever merges it by hand to run the check first", () => {
    expect(read(join(held.loop, ".pr-body"))).toContain(`check that \`${merge.cmd}\` passes`);
  });
  test("with PUSH true both commits reach main", () => {
    expect(statuses(loop)).toBe("keep keep");
    expect(fx.git(R, "log", "--format=%s", "main")).toContain("stub: work (agent call 2)");
  });
  test("but not while the check fails", () => {
    const seen = lines(push.seen);
    expect(seen.slice(0, 2)).toEqual([start, start]);
    expect(seen[2]).toBe(start);
  });
  test("and no iteration starts while the push waits", () => {
    const log = read(join(loop, "ralph.log"));
    expect(log.indexOf("holding the push to origin/main")).toBeLessThan(log.indexOf("pushed "));
    expect(log.indexOf("pushed ")).toBeLessThan(log.indexOf("=== iteration 2"));
  });
  test("one notification for the one wait", () => {
    expect(said(notes, "land-held").length).toBe(1);
  });
});
