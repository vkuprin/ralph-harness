import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { section } from "../../src/lib/text.ts";
import { Fx, join, read, setup, statuses } from "../helpers/index.ts";

// PROMPT.md's Hard constraints: what every result must pass. A loop that ranked
// options for a user listed two that failed requirements the user had called
// hard, labelled as near misses, and the reviewer passed every commit: nothing
// told it to check the result against them, and nothing kept them as written.
const fx = new Fx("hard");
const HARD = "## Hard constraints";
const hardOf = (loop: string) => section(read(join(loop, "PROMPT.md")), HARD).trim();
const GATED = { WORKTREE: true, PUSH: false, REVIEW: true, ITER_TIMEOUT: 30 };

describe("ralph steer --hard writes a numbered list", () => {
  const home = fx.p("home-list");
  const app = fx.p("app-list");
  const loop = join(home, "list");
  const old = join(home, "old");
  const two = "Never recommends option X\n## Why: it failed us";
  let first = { code: -1, out: "", err: "" };
  let usage = { code: -1, out: "", err: "" };
  let prompt = "";
  let added = "";
  let oldPrompt = "";
  let late = { code: -1, out: "", err: "" };
  let lateUntouched = false;

  setup(() => {
    fx.makeRepo(app, fx.p("remote-list.git"));
    fx.makeLoop(loop, app);
    first = fx.cli(home, ["steer", "--hard", "list", "Runs on Windows without WSL"]);
    fx.cli(home, ["steer", "--hard", "list", two]);
    prompt = read(join(loop, "PROMPT.md"));
    added = read(join(loop, ".hard-added"));
    fx.makeLoop(old, app);
    writeFileSync(join(old, "PROMPT.md"), "# old\n\n## The job\n\nDo the thing.\n");
    fx.cli(home, ["steer", "--hard", "old", "Costs under 20 EUR"]);
    oldPrompt = read(join(old, "PROMPT.md"));
    usage = fx.cli(home, ["steer", "--hard", "list", "  "]);
    late = fx.cli(home, ["steer", "list", "--hard", "Costs under 20 EUR"]);
    lateUntouched = read(join(loop, "PROMPT.md")) === prompt;
  });

  test("the template's placeholder gives way to item 1, and the next is item 2", () => {
    expect(section(prompt, HARD).trim()).toBe("1. Runs on Windows without WSL\n2. Never recommends option X\n   ## Why: it failed us");
  });
  test("it goes to Hard constraints, not to Steering", () => {
    expect(prompt).not.toContain("<!-- ralph-steer -->");
  });
  test("each entry is recorded, as typed, for the loop's guard", () => {
    expect(added).toBe(`${JSON.stringify("Runs on Windows without WSL")}\n${JSON.stringify(two)}\n`);
  });
  test("it says it is a hard constraint, and that the loop is stopped", () => {
    expect(first.code).toBe(0);
    expect(first.out).toContain("steered list (a hard constraint) — the loop is stopped");
  });
  test("a PROMPT.md without the section gets one, before the job", () => {
    expect(oldPrompt).toBe("# old\n\n## Hard constraints\n\n1. Costs under 20 EUR\n\n## The job\n\nDo the thing.\n");
  });
  test("--hard after the name is usage, not a steer that reads --hard", () => {
    expect(late.code).not.toBe(0);
    expect(late.err).toContain("usage: ralph steer");
    expect(lateUntouched).toBe(true);
  });
  test("a hard steer of blank text is usage", () => {
    expect(usage.code).not.toBe(0);
    expect(usage.err).toContain("ralph steer --hard <name>");
  });
});

describe("the reviewer holds each commit to the Hard constraints", () => {
  const home = fx.p("home-rev");
  const app = fx.p("app-rev");
  const loop = join(home, "rev");
  const plain = join(home, "plain");
  let S = "";
  let P = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-rev.git"));
    S = fx.stub("stub-rev", ["commit", "commit"], ["REJECT: constraint 1: it ranks option X third", "ACCEPT"]);
    fx.makeLoop(loop, app, { ...GATED, MAX_ITER: 2 });
    fx.cli(home, ["steer", "--hard", "rev", "Never recommends option X"]);
    await fx.runLoop(loop, S);
    P = fx.stub("stub-plain", ["commit"], ["REJECT: it is wrong"]);
    fx.makeLoop(plain, app, { ...GATED, MAX_ITER: 1 });
    await fx.runLoop(plain, P);
  });

  test("the reviewer is handed them verbatim, under their own heading", () => {
    const brief = read(join(S, "prompt.review.1"));
    expect(brief).toContain("## Hard constraints (from the human, each one pass/fail)\n\n1. Never recommends option X\n");
    expect(brief).toContain("including when it is labelled conditional, near-miss or\nfallback");
    expect(brief).toContain("A result that says no option passes is acceptable and complete.");
  });
  test("a commit rejected on a constraint is revert:constraint; the next, accepted, is kept", () => {
    expect(statuses(loop)).toBe("revert:constraint keep");
  });
  test("the agent is handed them, and the rule against filling the list with near misses", () => {
    const p = read(join(S, "prompt.agent.1"));
    expect(p).toContain("1. Never recommends option X");
    expect(p).toContain("do not fill\n  the list with the nearest misses");
  });
  test("with only the placeholder there is no constraints block, and a plain reject is revert:review", () => {
    expect(read(join(P, "prompt.review.1"))).not.toContain("## Hard constraints (from");
    expect(statuses(plain)).toBe("revert:review");
  });
});

describe("an iteration cannot loosen the Hard constraints", () => {
  const home = fx.p("home-loose");
  const app = fx.p("app-loose");
  const loop = join(home, "loose");
  let S = "";
  let log = "";
  let after = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-loose.git"));
    S = fx.stub("stub-loose", ["loosen"], ["ACCEPT"]);
    fx.makeLoop(loop, app, { ...GATED, MAX_ITER: 1 });
    fx.cli(home, ["steer", "--hard", "loose", "Runs on Windows"]);
    fx.cli(home, ["steer", "--hard", "loose", "Never recommends option X"]);
    await fx.runLoop(loop, S);
    log = read(join(loop, "ralph.log"));
    after = hardOf(loop);
  });

  test("the section is put back as the human left it", () => {
    expect(after).toBe("1. Runs on Windows\n2. Never recommends option X");
  });
  test("the log says so", () => {
    expect(log).toContain("hard constraints: iteration 1 changed them; put back as they were");
  });
  test("the reviewer judged against the human's list, not the agent's", () => {
    const brief = read(join(S, "prompt.review.1"));
    expect(brief).toContain("2. Never recommends option X\n");
    expect(brief).not.toContain("unless the option comes close");
  });
});

describe("a hard steer that lands mid-iteration is kept", () => {
  const home = fx.p("home-mid");
  const app = fx.p("app-mid");
  const loop = join(home, "mid");
  let S = "";
  let log = "";
  let after = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-mid.git"));
    fx.makeLoop(loop, app, { ...GATED, MAX_ITER: 1 });
    fx.cli(home, ["steer", "--hard", "mid", "Runs on Windows"]);
    const before = read(join(loop, "PROMPT.md"));
    // What the real CLI writes for the second steer, replayed by the agent
    // while it runs; the loop starts from the first.
    fx.cli(home, ["steer", "--hard", "mid", "Never recommends option X"]);
    S = fx.stub("stub-mid", ["hard-mid"], ["ACCEPT"]);
    writeFileSync(join(S, "prompt-after-steer"), read(join(loop, "PROMPT.md")));
    writeFileSync(join(S, "added-after-steer"), `${read(join(loop, ".hard-added")).trim().split("\n").at(-1)}\n`);
    writeFileSync(join(loop, "PROMPT.md"), before);
    writeFileSync(join(loop, ".hard-added"), "");
    await fx.runLoop(loop, S);
    log = read(join(loop, "ralph.log"));
    after = hardOf(loop);
  });

  test("the human's entry stays, and the agent's change does not", () => {
    expect(after).toBe("1. Runs on Windows\n2. Never recommends option X");
    expect(log).toContain("hard constraints: iteration 1 changed them");
  });
  test("the reviewer is handed it", () => {
    expect(read(join(S, "prompt.review.1"))).toContain("2. Never recommends option X\n");
  });
});
