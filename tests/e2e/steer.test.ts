import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { cliPath, Fx, hookArgv, join, read, setup, statuses } from "../helpers/index.ts";

const fx = new Fx("steer");

interface HookOut {
  decision?: string;
  reason?: string;
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}

describe("live steer hook", () => {
  const steer = fx.p("steer.md");
  let first = "";
  let second = "";
  let afterFirst = "x";
  let delivered = "";

  setup(() => {
    writeFileSync(steer, "drop the CSS work\n");
    first = fx.sh([...hookArgv()], { env: { RALPH_STEER_FILE: steer } }).out;
    afterFirst = read(steer);
    delivered = read(`${steer}.delivered`);
    second = fx.sh([...hookArgv()], { env: { RALPH_STEER_FILE: steer } }).out;
  });

  // bash prints {"decision":"block","reason":…}; the TypeScript hook prints
  // Claude Code's hookSpecificOutput form with permissionDecision "deny".
  test("the hook blocks the tool call once, with the text as the reason", () => {
    const out = JSON.parse(first) as HookOut;
    const blocked = out.decision === "block" || out.hookSpecificOutput?.permissionDecision === "deny";
    const reason = out.reason ?? out.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(blocked).toBe(true);
    expect(reason).toContain("drop the CSS work");
  });
  test("the hook empties STEER.md", () => {
    expect(afterFirst).toBe("");
  });
  test("the hook keeps what it delivered for the reviewer", () => {
    expect(delivered).toContain("drop the CSS work");
  });
  test("an empty STEER.md lets every call through", () => {
    expect(second).toMatch(/^\n*$/);
  });
});

describe("ralph steer keeps the text it was handed", () => {
  // awk's -v processes escape sequences in the value it assigns, so a steer
  // holding a Windows path or a regex reached PROMPT.md with tabs and newlines
  // in it, and the newline broke the second half of the entry out of the list.
  const app = fx.p("app-esc");
  const home = fx.p("home-esc");
  const loop = join(home, "esc");
  const escText = String.raw`look in C:\temp\new, split on \t, match \q and keep a & b`;
  const escPlain = "the second steer, newest first";
  let S = "";
  let steerFile = "";
  let prompt = "";

  /** Everything from the marker line on, the marker included. */
  const fromMarker = () => {
    const lines = prompt.split("\n");
    const at = lines.findIndex((l) => l.includes("<!-- ralph-steer -->"));
    return at < 0 ? [] : lines.slice(at);
  };
  /** Everything the steer wrote: the lines after the marker. */
  const entries = () => fromMarker().slice(1);

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-esc.git"));
    S = fx.stub("stub-esc", ["commit"], ["ACCEPT"]);
    fx.makeLoop(loop, app, { WORKTREE: true, PUSH: false, REVIEW: true, MAX_ITER: 1, ITER_TIMEOUT: 30 });
    fx.cli(home, ["steer", "esc", escText]);
    fx.cli(home, ["steer", "esc", escPlain]);
    steerFile = read(join(loop, "STEER.md"));
    prompt = read(join(loop, "PROMPT.md"));
    // The two consumers, not the file: the agent is handed PROMPT.md whole, and
    // the reviewer is handed its Steering section.
    await fx.runLoop(loop, S);
  });

  test("STEER.md holds the text the human typed", () => {
    expect(steerFile.split("\n")).toContain(escText);
  });
  test("PROMPT.md holds the text the human typed", () => {
    expect(prompt).toContain(escText);
  });
  test("nothing the steer wrote sits outside its list item", () => {
    expect(entries().filter((l) => !l.startsWith("- [") && l !== "")).toEqual([]);
  });
  test("one list item per steer, not one per line of mangled text", () => {
    expect(entries().filter((l) => l.startsWith("- [")).length).toBe(2);
  });
  test("an ordinary steer still reaches PROMPT.md", () => {
    expect(prompt).toContain(escPlain);
  });
  test("the newest steer is still the first entry", () => {
    const first = fromMarker().find((l) => l.startsWith("- [")) ?? "";
    expect(first.endsWith(escPlain)).toBe(true);
  });
  test("the steered iteration ran and its commit was kept", () => {
    expect(statuses(loop)).toBe("keep");
  });
  test("the agent's prompt holds the text the human typed", () => {
    expect(read(join(S, "prompt.agent.1"))).toContain(escText);
  });
  test("the reviewer's steering section holds the text the human typed", () => {
    expect(read(join(S, "prompt.review.1"))).toContain(escText);
  });
});

describe("a steer of several lines stays one entry of the Steering section", () => {
  // The text went into PROMPT.md as typed, so a line of it that starts with
  // `## ` became a heading of PROMPT.md. The reviewer's brief takes the Steering
  // section up to the next heading, and lost every line after it: the reviewer
  // judged the commit against the first half of what the human asked.
  const app = fx.p("app-ml");
  const home = fx.p("home-ml");
  const loop = join(home, "ml");
  const text = [
    "Stop the CSS work.",
    "",
    "## Why",
    "The stylesheet is frozen until the redesign lands.",
    "",
    "## Instead",
    "Fix the login timeout first.",
  ].join("\n");
  const said = text.split("\n").filter((l) => l !== "");
  let S = "";
  let prompt = "";
  let steerFile = "";
  let blank = { code: 0, out: "", err: "" };
  let afterBlank = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-ml.git"));
    S = fx.stub("stub-ml", ["commit"], ["ACCEPT"]);
    fx.makeLoop(loop, app, { WORKTREE: true, PUSH: false, REVIEW: true, MAX_ITER: 1, ITER_TIMEOUT: 30 });
    fx.cli(home, ["steer", "ml", text]);
    steerFile = read(join(loop, "STEER.md"));
    prompt = read(join(loop, "PROMPT.md"));
    blank = fx.cli(home, ["steer", "ml", " \n\t\n"]);
    afterBlank = read(join(loop, "PROMPT.md"));
    await fx.runLoop(loop, S);
  });

  /** The lines the steer wrote under the marker. */
  const entries = () => {
    const lines = prompt.split("\n");
    return lines.slice(lines.findIndex((l) => l.includes("<!-- ralph-steer -->")) + 1);
  };
  /** The Steering section of the reviewer's brief. */
  const reviewed = () => {
    const brief = read(join(S, "prompt.review.1"));
    return brief.slice(brief.indexOf("## Steering from the human"), brief.indexOf("## What the harness already checked"));
  };

  test("no line of the steer is a heading of PROMPT.md", () => {
    expect(entries().filter((l) => l.startsWith("#"))).toEqual([]);
  });
  test("every line of it sits inside its list item", () => {
    expect(entries().filter((l) => l !== "" && !l.startsWith("- [") && !l.startsWith("  "))).toEqual([]);
    expect(entries().filter((l) => l.startsWith("- [")).length).toBe(1);
  });
  test("the reviewer is handed every line the human typed", () => {
    for (const line of said) expect(reviewed()).toContain(line);
  });
  test("the agent is handed every line too", () => {
    const agent = read(join(S, "prompt.agent.1"));
    for (const line of said) expect(agent).toContain(line);
  });
  test("STEER.md holds the text as typed, for the steer hook", () => {
    expect(steerFile).toBe(`${text}\n`);
  });
  test("a steer of blank lines is no steer: usage, and PROMPT.md is left alone", () => {
    expect(blank.code).not.toBe(0);
    expect(blank.err).toContain("usage: ralph steer");
    expect(afterBlank).toBe(prompt);
  });
  test("the steered iteration ran and its commit was kept", () => {
    expect(statuses(loop)).toBe("keep");
  });
});

describe("a steer delivered mid-iteration reaches the reviewer once", () => {
  // `ralph steer` writes PROMPT.md's Steering section and STEER.md, and the
  // hook keeps what it delivered for the reviewer. The reviewer was handed the
  // section and the delivered copy both: every mid-iteration steer twice.
  const app = fx.p("app-once");
  const home = fx.p("home-once");
  const loop = join(home, "once");
  const text = "focus on the login flow, not the CSS";
  let S = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-once.git"));
    S = fx.stub("stub-once", ["run-hook"], ["ACCEPT"]);
    writeFileSync(join(S, "steer-cli"), JSON.stringify({ argv: [process.execPath, cliPath(), "steer", "once", text], home }));
    fx.makeLoop(loop, app, { WORKTREE: true, PUSH: false, REVIEW: true, MAX_ITER: 1, ITER_TIMEOUT: 30 });
    await fx.runLoop(loop, S);
  });

  test("the steer went to PROMPT.md and was delivered by the hook", () => {
    expect(read(join(loop, "PROMPT.md"))).toContain(text);
    expect(read(join(loop, "STEER.md.delivered"))).toContain(text);
  });
  test("the reviewer's brief holds it once", () => {
    expect(read(join(S, "prompt.review.1")).split(text).length - 1).toBe(1);
  });
  test("the log says a steer was delivered", () => {
    expect(read(join(loop, "ralph.log"))).toContain(`steer delivered mid-iteration: ${text}`);
  });
});
