import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { Fx, hookArgv, join, read, setup, statuses } from "../helpers/index.ts";

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
