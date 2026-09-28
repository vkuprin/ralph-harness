import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import {
  count,
  events,
  Fx,
  join,
  lines,
  mkNotifier,
  read,
  rows,
  setup,
  sq,
  statuses,
  type LoopRun,
} from "../helpers/index.ts";

const fx = new Fx("features");



/** The line after each line that is exactly `flag`, as `grep -A1 -x -- flag` finds them. */
function after(file: string, flag: string): string[] {
  const ls = read(file).split("\n");
  const out: string[] = [];
  ls.forEach((l, i) => {
    if (l === flag && i + 1 < ls.length) out.push(ls[i + 1]!);
  });
  return out;
}
function hasLine(file: string, line: string): boolean {
  return read(file).split("\n").includes(line);
}

/** `sed -n '/start/,/end/p'`: every range from a line matching start to the next line matching end. */
function sedRange(text: string, start: RegExp, end?: RegExp): string {
  const out: string[] = [];
  let on = false;
  for (const l of text.split("\n")) {
    if (on) {
      out.push(l);
      if (end && end.test(l)) on = false;
    } else if (start.test(l)) {
      out.push(l);
      on = true;
    }
  }
  return out.join("\n");
}

/** Wait up to `secs` for a background loop; stop it and say so if it is still going. */
async function within(run: LoopRun, secs: number): Promise<number | "timeout"> {
  const r = await Promise.race([run.done, Bun.sleep(secs * 1000).then(() => "timeout" as const)]);
  if (r === "timeout") {
    run.proc.kill();
    await run.done;
  }
  return r;
}

describe("the reviewer sees what done looks like; the loop sees what it shipped", () => {
  const doneText = "The landing page renders with the brand fonts and colours at 375 px and 1440 px.";
  const loop = fx.p("loops/done");
  const loop2 = fx.p("loops/done2");
  let S = "";
  let S2 = "";

  setup(async () => {
    // The human's picture of the finished result goes to the reviewer, as a
    // thing a commit may not contradict, never as a bar every step must clear.
    fx.makeRepo(fx.p("app-done"), fx.p("remote-done.git"));
    S = fx.stub("stub-done", ["commit", "commit", "commit"]);
    fx.makeLoop(loop, fx.p("app-done"), {
      WORKTREE: true,
      PUSH: true, PUSH_CONFIRM: "main",
      REVIEW: true,
      MAX_ITER: 3,
      VERIFY_CMD: "./measure.sh",
      REVIEW_MODEL: "haiku-for-review",
    });
    const out: string[] = [];
    let skip = false;
    for (const l of read(join(loop, "PROMPT.md")).split("\n")) {
      if (l.startsWith("## Done looks like")) {
        out.push(l, "", doneText, "");
        skip = true;
        continue;
      }
      if (skip && l.startsWith("## ")) skip = false;
      if (!skip) out.push(l);
    }
    writeFileSync(join(loop, "PROMPT.md"), out.join("\n"));
    await fx.runLoop(loop, S, { remote: fx.p("remote-done.git") });

    // The template's own placeholder is not a picture of anything.
    fx.makeRepo(fx.p("app-done2"), fx.p("remote-done2.git"));
    S2 = fx.stub("stub-done2", ["commit"]);
    fx.makeLoop(loop2, fx.p("app-done2"), { WORKTREE: true, PUSH: true, PUSH_CONFIRM: "main", REVIEW: true, MAX_ITER: 1, VERIFY_CMD: "./measure.sh" });
    await fx.runLoop(loop2, S2, { remote: fx.p("remote-done2.git") });
  });

  test("the reviewer is shown what done looks like", () => {
    expect(read(join(S, "prompt.review.1"))).toContain(doneText);
  });
  test("and told a step toward it is not a reason to reject", () => {
    expect(read(join(S, "prompt.review.1"))).toMatch(/not the finished result yet/i);
  });
  test("the reviewer runs on REVIEW_MODEL", () => {
    expect(hasLine(join(S, "argv.review.1"), "haiku-for-review")).toBe(true);
  });
  test("the agent still runs on MODEL", () => {
    expect(read(join(S, "argv.agent.1"))).not.toContain("haiku-for-review");
  });
  test("the third prompt lists what the loop shipped, from git", () => {
    expect(sedRange(read(join(S, "prompt.agent.3")), /^# What this loop shipped recently/)).toContain(
      "stub: work (agent call 2)",
    );
  });
  test("and the first prompt, with nothing shipped yet, has no such list", () => {
    expect(read(join(S, "prompt.agent.1"))).not.toMatch(/^# What this loop shipped recently/m);
  });
  test("a Done looks like left as the template's placeholder is not shown", () => {
    expect(read(join(S2, "prompt.review.1"))).not.toContain("What done looks like");
  });
  test("without REVIEW_MODEL the reviewer runs on MODEL", () => {
    expect(after(join(S2, "argv.review.1"), "--model")).toContain("opus");
  });
});

describe("DONE_CMD: a finished job stops the loop", () => {
  // DONE_CMD is the human's own check of "done", run by the harness, never the
  // model's say-so.
  const loop = fx.p("loops/fin");
  const loop2 = fx.p("loops/fin2");
  const remote = fx.p("remote-fin.git");

  setup(async () => {
    fx.makeRepo(fx.p("app-fin"), remote);
    const S = fx.stub("stub-fin", ["commit", "finish", "commit", "commit"]);
    fx.makeLoop(loop, fx.p("app-fin"), { WORKTREE: true, PUSH: true, PUSH_CONFIRM: "main", MAX_ITER: 5, DONE_CMD: "test -f FINISHED" });
    await fx.runLoop(loop, S, { remote });

    fx.makeRepo(fx.p("app-fin2"), fx.p("remote-fin2.git"));
    const S2 = fx.stub("stub-fin2", ["commit", "commit"]);
    fx.makeLoop(loop2, fx.p("app-fin2"), {
      WORKTREE: true,
      PUSH: true, PUSH_CONFIRM: "main",
      MAX_ITER: 2,
      DONE_CMD: 'test -f BACKLOG.md && ! grep -q "^- \\[ \\]" BACKLOG.md',
    });
    await fx.runLoop(loop2, S2, { remote: fx.p("remote-fin2.git") });
  });

  test("the loop stops once DONE_CMD says done", () => {
    expect(statuses(loop)).toBe("keep keep");
  });
  test("it says why", () => {
    expect(read(join(loop, "ralph.log"))).toContain("DONE_CMD says the job is done");
  });
  test("the commit that finished the job was pushed before it stopped", () => {
    expect(fx.git(remote, "log", "--format=%s", "main")).toContain("stub: finish");
  });
  test("the check that stopped it is not counted as an iteration", () => {
    expect(read(join(loop, "ralph.log"))).toContain("finished after 2 iterations");
  });
  test("a DONE_CMD that fails (no backlog file yet) never stops the loop", () => {
    expect(statuses(loop2)).toBe("keep keep");
  });
});

describe("ACTIVE_HOURS: the loop keeps to its window", () => {
  // The hour comes from the fake clock, so the test does not wait for night.
  // 08 and 09 are in the list on purpose: bash reads a leading zero as octal,
  // and $((08)) is an error that ends the script.
  const loop = fx.p("loops/hrs");
  const bad = fx.p("loops/hrs-bad");
  const bad2 = fx.p("loops/hrs-bad2");
  const hour = fx.p("hour-hrs");
  let S = "";
  let noAgentAt08 = false;
  let aliveAt09 = false;
  let noAgentAt09 = false;
  let ended: number | "timeout" = "timeout";

  setup(async () => {
    fx.makeRepo(fx.p("app-hrs"), fx.p("remote-hrs.git"));
    S = fx.stub("stub-hrs", ["commit"]);
    fx.makeLoop(loop, fx.p("app-hrs"), { MAX_ITER: 1, ACTIVE_HOURS: "22-08", ACTIVE_POLL: 1 });
    writeFileSync(hour, "08\n");
    const run = fx.startLoop(loop, S, { env: { RALPH_TEST_HOUR: hour } });
    for (let i = 0; i < 50; i++) {
      if (read(join(loop, "ralph.log")).includes("outside ACTIVE_HOURS")) break;
      await Bun.sleep(100);
    }
    await Bun.sleep(1500);
    noAgentAt08 = !existsSync(join(S, "agent_calls"));
    writeFileSync(hour, "09\n");
    await Bun.sleep(1500);
    aliveAt09 = run.proc.exitCode === null;
    noAgentAt09 = !existsSync(join(S, "agent_calls"));
    writeFileSync(hour, "23\n");
    ended = await within(run, 60);

    fx.makeLoop(bad, fx.p("app-hrs"), { ACTIVE_HOURS: "7-7" });
    await within(fx.startLoop(bad, fx.stub("stub-hrs-bad")), 60);
    fx.makeLoop(bad2, fx.p("app-hrs"), { ACTIVE_HOURS: "25-3" });
    await within(fx.startLoop(bad2, fx.stub("stub-hrs-bad2")), 60);
  });

  test("outside the window (08, end hour excluded) no agent runs", () => {
    expect(noAgentAt08).toBe(true);
  });
  test("at 08 and 09 the loop is waiting, not dead of octal", () => {
    expect(aliveAt09).toBe(true);
  });
  test("and still no agent has run", () => {
    expect(noAgentAt09).toBe(true);
  });
  test("inside the window (23) the iteration runs", () => {
    expect(ended).not.toBe("timeout");
    expect(statuses(loop)).toBe("keep");
  });
  test("the wait was logged once, not once per poll", () => {
    expect(count(read(join(loop, "ralph.log")), /outside ACTIVE_HOURS/)).toBe(1);
  });
  test("an ACTIVE_HOURS that opens and closes at once refuses the start", () => {
    expect(read(join(bad, "ralph.log"))).toContain("ACTIVE_HOURS");
  });
  test("and runs nothing", () => {
    expect(existsSync(join(bad, "results.tsv"))).toBe(false);
  });
  test("an hour past 23 refuses the start", () => {
    expect(existsSync(join(bad2, "results.tsv"))).toBe(false);
  });
});

describe("DENY: tool patterns the agent may not use", () => {
  let S = "";
  let S0 = "";
  const loop0 = fx.p("loops/deny0");

  setup(async () => {
    fx.makeRepo(fx.p("app-deny"), fx.p("remote-deny.git"));
    S = fx.stub("stub-deny", ["nothing"]);
    fx.makeLoop(fx.p("loops/deny"), fx.p("app-deny"), { MAX_ITER: 1, DENY: ["Bash(ssh *)", "Bash(psql *)"] });
    await fx.runLoop(fx.p("loops/deny"), S);
    S0 = fx.stub("stub-deny0", ["nothing"]);
    fx.makeLoop(loop0, fx.p("app-deny"), { MAX_ITER: 1, DENY: [] });
    await fx.runLoop(loop0, S0);
  });

  test("every DENY pattern reaches claude as its own --disallowedTools", () => {
    expect(after(join(S, "argv.agent.1"), "--disallowedTools").filter((l) => /^Bash\((ssh|psql) \*\)$/.test(l))).toHaveLength(2);
  });
  test("an empty DENY passes nothing and breaks nothing", () => {
    expect(hasLine(join(S0, "argv.agent.1"), "--disallowedTools")).toBe(false);
    expect(read(join(loop0, "ralph.log"))).toContain("finished after 1");
  });
});

describe("what an iteration costs", () => {
  // The agent and the reviewer answer in JSON; the harness keeps the text for
  // the log and the cost for results.tsv.
  const loop = fx.p("loops/cost");
  let S = "";
  let review = "";

  setup(async () => {
    fx.makeRepo(fx.p("app-cost"), fx.p("remote-cost.git"));
    S = fx.stub("stub-cost", ["commit", "limit", "commit"]);
    fx.makeLoop(loop, fx.p("app-cost"), { WORKTREE: true, PUSH: true, PUSH_CONFIRM: "main", REVIEW: true, MAX_ITER: 2, VERIFY_CMD: "./measure.sh" });
    await fx.runLoop(loop, S, { remote: fx.p("remote-cost.git") });
    review = fx.cli(fx.p("loops"), ["review", "cost"]).out;
  });

  test("the agent is asked for JSON", () => {
    expect(hasLine(join(S, "argv.agent.1"), "--output-format")).toBe(true);
  });
  test("a limit is still read out of a JSON error", () => {
    expect(statuses(loop)).toBe("keep ratelimit keep");
  });
  test("results.tsv has cost and token columns", () => {
    expect(read(join(loop, "results.tsv"))).toContain("reason\tcost_usd\ttokens");
  });
  test("a kept row adds the agent's cost and the reviewer's", () => {
    expect(rows(loop)[0]!.slice(7, 9)).toEqual(["0.0143", "200"]);
  });
  test("the verdict is found through the JSON path", () => {
    expect(read(join(loop, "review.out"))).toMatch(/^VERDICT: ACCEPT/m);
  });
  test("the log holds the text, not the JSON", () => {
    const log = read(join(loop, "ralph.log"));
    expect(log).toContain("Read the diff.");
    expect(log).not.toContain("total_cost_usd");
  });
  test("the agent's verdict table keeps its seven columns", () => {
    expect(sedRange(read(join(S, "prompt.agent.2")), /# Harness verdicts/, /^---/)).not.toContain("cost_usd");
  });
  test("review totals the cost, as an API-equivalent figure", () => {
    expect(review).toContain("API-equivalent");
  });
});

describe("HEALTH_CMD: a broken system leads the prompt until it is fixed", () => {
  // The stub's `sicken` commit breaks "production" (a file HEALTH_CMD reads),
  // and `heal` fixes it. DONE_CMD here says "done" whenever production is
  // broken, so the loop only reaches its fourth iteration if DONE_CMD is not
  // asked while HEALTH_CMD fails.
  const H = fx.p("loops/hl");
  const notes = fx.p("notify-hl.log");
  let S = "";

  setup(async () => {
    fx.makeRepo(fx.p("app-hl"), fx.p("remote-hl.git"));
    S = fx.stub("stub-hl", ["sicken", "nothing", "heal", "nothing"]);
    mkNotifier(notes, fx.p("notify-hl.sh"));
    fx.makeLoop(H, fx.p("app-hl"), {
      WORKTREE: true,
      MAX_ITER: 4,
      HEALTH_CMD: 'if [ -f "$STUB_DIR/sick" ]; then echo "watch 42 has been silent for 30h"; exit 1; fi',
      DONE_CMD: 'test -f "$STUB_DIR/sick"',
      NOTIFY_CMD: fx.p("notify-hl.sh"),
    });
    await fx.runLoop(H, S);
  });

  test("all four iterations ran", () => {
    expect(statuses(H)).toBe("keep quiet keep quiet");
  });
  test("DONE_CMD is not asked while the check fails", () => {
    expect(read(join(H, "ralph.log"))).toContain("DONE_CMD not asked");
  });
  test("a healthy system adds nothing to the prompt", () => {
    expect(read(join(S, "prompt.agent.1"))).not.toContain("health check is failing");
  });
  test("a failing one leads the prompt", () => {
    expect(read(join(S, "prompt.agent.2"))).toContain("health check is failing");
  });
  test("with the check's own output", () => {
    expect(read(join(S, "prompt.agent.2"))).toContain("watch 42 has been silent");
  });
  test("and the commits since it last passed, as suspects", () => {
    expect(read(join(S, "prompt.agent.2"))).toContain("stub: sicken");
  });
  test("ahead of the loop's memory", () => {
    // One of each, as `test "$(grep -n …)" -lt "$(grep -n …)"` needs, and in that order.
    const ls = read(join(S, "prompt.agent.2")).split("\n");
    const health = ls.flatMap((l, i) => (l.includes("health check is failing") ? [i] : []));
    const memory = ls.flatMap((l, i) => (l.startsWith("# PROGRESS.md") ? [i] : []));
    expect(health).toHaveLength(1);
    expect(memory).toHaveLength(1);
    expect(health[0]!).toBeLessThan(memory[0]!);
  });
  test("for as long as it fails", () => {
    expect(read(join(S, "prompt.agent.3"))).toContain("health check is failing");
  });
  test("and not once it passes", () => {
    expect(read(join(S, "prompt.agent.4"))).not.toContain("health check is failing");
  });
  test("a human hears it break once and recover once", () => {
    expect(events(notes)).toEqual(["health", "health-clear", "stopped"]);
  });
});

describe("churn: the files the loop keeps changing are named", () => {
  // Which files keep changing is counted from git, over the keep rows, and put
  // in front of the agent, the reviewer and the human. Every stub commit
  // appends to work.txt, so it is the file that churns.
  const loop = fx.p("loops/ch");
  const notes = fx.p("notify-ch.log");
  let S = "";
  let S2 = "";
  let S3 = "";

  setup(async () => {
    fx.makeRepo(fx.p("app-ch"), fx.p("remote-ch.git"));
    S = fx.stub("stub-ch", ["commit", "commit", "commit", "commit", "commit"]);
    mkNotifier(notes, fx.p("notify-ch.sh"));
    fx.makeLoop(loop, fx.p("app-ch"), {
      WORKTREE: true,
      REVIEW: true,
      MAX_ITER: 5,
      CHURN_AT: 3,
      CHURN_WINDOW: 8,
      NOTIFY_CMD: fx.p("notify-ch.sh"),
    });
    await fx.runLoop(loop, S);

    fx.makeRepo(fx.p("app-ch2"), fx.p("remote-ch2.git"));
    S2 = fx.stub("stub-ch2", ["commit", "commit", "commit"]);
    fx.makeLoop(fx.p("loops/ch2"), fx.p("app-ch2"), { WORKTREE: true, MAX_ITER: 3, CHURN_AT: 2, CHURN_IGNORE: ["work.txt"] });
    await fx.runLoop(fx.p("loops/ch2"), S2);

    // CHURN_AT left at its default: four commits to work.txt, and the fourth
    // prompt still names nothing.
    fx.makeRepo(fx.p("app-ch3"), fx.p("remote-ch3.git"));
    S3 = fx.stub("stub-ch3", ["commit", "commit", "commit", "commit"]);
    fx.makeLoop(fx.p("loops/ch3"), fx.p("app-ch3"), { WORKTREE: true, MAX_ITER: 4 });
    await fx.runLoop(fx.p("loops/ch3"), S3);
  });

  test("every iteration shipped", () => {
    expect(statuses(loop)).toBe("keep keep keep keep keep");
  });
  test("two changes to one file are not churn yet", () => {
    expect(read(join(S, "prompt.agent.3"))).not.toContain("same files keep changing");
  });
  test("the third is, and the agent is told", () => {
    expect(read(join(S, "prompt.agent.4"))).toContain("same files keep changing");
  });
  test("with the file and its count, from git", () => {
    expect(read(join(S, "prompt.agent.4"))).toContain("work.txt, changed in 3 of them");
  });
  test("the reviewer is not told before then", () => {
    expect(read(join(S, "prompt.review.3"))).not.toContain("Files this loop keeps changing");
  });
  test("and is told when the commit touches the file again", () => {
    const p = read(join(S, "prompt.review.4"));
    expect(p).toContain("Files this loop keeps changing");
    expect(p).toContain("work.txt, changed in 3");
  });
  test("a human hears it once, not every iteration it stays", () => {
    expect(count(read(notes), /^churn/)).toBe(1);
  });
  test("CHURN_IGNORE leaves a file out of the count", () => {
    expect(read(join(S2, "prompt.agent.3"))).not.toContain("same files keep changing");
  });
  test("and with CHURN_AT unset nothing is counted at all", () => {
    expect(statuses(fx.p("loops/ch3"))).toBe("keep keep keep keep");
    expect(read(join(S3, "prompt.agent.4"))).not.toContain("same files keep changing");
  });
});
