import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { Fx, ROOT, cliPath, join, lines, read, setup, statuses } from "../helpers/index.ts";

// PLAN_FIRST starts the agent in plan mode with the harness's MCP server as the
// one thing that answers its approval prompts; `ralph setup` opens Claude Code
// with the ralph-new skill. Both are off the path a default loop takes.

const fx = new Fx("plan");

/** The argument after each occurrence of `flag` in a recorded argv file. */
function after(argvFile: string, flag: string): string[] {
  const a = lines(argvFile);
  return a.flatMap((x, i) => (x === flag && i + 1 < a.length ? [a[i + 1]!] : []));
}

describe("a loop without PLAN_FIRST runs as it always did", () => {
  const app = fx.p("app-off");
  const loop = fx.p("loops/off");
  let S = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-off.git"));
    S = fx.stub("stub-off", ["commit"]);
    fx.makeLoop(loop, app, { MAX_ITER: 1 });
    await fx.runLoop(loop, S);
  });

  test("the agent skips permissions and is not in plan mode", () => {
    const a = lines(join(S, "argv.agent.1"));
    expect(a).toContain("--dangerously-skip-permissions");
    expect(a).not.toContain("--permission-mode");
    expect(a).not.toContain("--permission-prompt-tool");
  });
  test("there is no MCP config and no plan section in the prompt", () => {
    expect(existsSync(join(loop, ".plan-mcp.json"))).toBe(false);
    expect(read(join(S, "prompt.agent.1"))).not.toContain("# Plan first");
    expect(read(join(loop, "ralph.log"))).not.toContain("plan approved:");
  });
});

describe("PLAN_FIRST: plan mode, approved by the harness, carried out in the same run", () => {
  const app = fx.p("app-on");
  const loop = fx.p("loops/on");
  let S = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-on.git"));
    S = fx.stub("stub-on", ["plan-approve"]);
    fx.makeLoop(loop, app, { MAX_ITER: 1, PLAN_FIRST: true, DENY: ["Bash(ssh *)"], CLOSING: "Close with this." });
    await fx.runLoop(loop, S);
  });

  test("the agent starts in plan mode with bypass available but not on", () => {
    const a = lines(join(S, "argv.agent.1"));
    expect(after(join(S, "argv.agent.1"), "--permission-mode")).toEqual(["plan"]);
    expect(a).toContain("--allow-dangerously-skip-permissions");
    expect(a).not.toContain("--dangerously-skip-permissions");
  });
  test("its approval prompts go to the harness's MCP tool", () => {
    expect(after(join(S, "argv.agent.1"), "--permission-prompt-tool")).toEqual(["mcp__ralph__approve"]);
    expect(after(join(S, "argv.agent.1"), "--mcp-config")).toEqual([join(loop, ".plan-mcp.json")]);
    const cfg = JSON.parse(read(join(loop, ".plan-mcp.json"))).mcpServers.ralph;
    expect(cfg.args[0]).toBe(join(ROOT, "hooks/approve-plan.ts"));
    expect(cfg.env.RALPH_PLAN_FILE).toBe(join(loop, ".plan.md"));
  });
  test("DENY still reaches the agent", () => {
    expect(after(join(S, "argv.agent.1"), "--disallowedTools")).toEqual(["Bash(ssh *)"]);
  });
  test("the prompt says so, and CLOSING is still last", () => {
    const p = read(join(S, "prompt.agent.1"));
    expect(p).toContain("# Plan first");
    expect(p.endsWith("\n---\n\nClose with this.\n")).toBe(true);
  });

  const answers = () =>
    read(join(S, "approve.1"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  const decision = (id: number) => JSON.parse(answers().find((m) => m.id === id).result.content[0].text);

  test("the server lists one tool, approve", () => {
    expect(answers().find((m) => m.id === 2).result.tools.map((t: { name: string }) => t.name)).toEqual(["approve"]);
  });
  test("ExitPlanMode is approved, with its input, and the session switches to bypass", () => {
    expect(decision(3)).toEqual({
      behavior: "allow",
      updatedInput: { plan: "stub plan: edit work.txt\n" },
      updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }],
    });
  });
  test("any other prompt is denied", () => {
    expect(decision(4).behavior).toBe("deny");
  });
  test("the approved plan is in the log, and the iteration shipped", () => {
    const log = read(join(loop, "ralph.log"));
    expect(log).toContain("plan approved:\n");
    expect(log).toContain("stub plan: edit work.txt");
    expect(log).toContain("plan_first=1");
    expect(statuses(loop)).toBe("keep");
  });
});

describe("PLAN_FIRST when the agent never asks to leave plan mode", () => {
  const app = fx.p("app-noplan");
  const loop = fx.p("loops/noplan");

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-noplan.git"));
    fx.makeLoop(loop, app, { MAX_ITER: 1, PLAN_FIRST: true });
    await fx.runLoop(loop, fx.stub("stub-noplan", ["nothing"]));
  });

  test("the log says no plan was approved, and the iteration is quiet", () => {
    expect(read(join(loop, "ralph.log"))).toContain("no plan was approved");
    expect(statuses(loop)).toBe("quiet");
  });
});

describe("ralph setup opens Claude Code with the ralph-new skill, where it was run", () => {
  const repo = fx.p("setup-repo");
  const home = fx.p("setup-home");
  let S = "";
  let setupCode = -1;
  let bareCode = -1;
  let missing = { code: -1, err: "" };

  setup(() => {
    mkdirSync(repo);
    S = fx.stub("stub-setup");
    const env = { RALPH_HOME: home, STUB_DIR: S };
    setupCode = fx.sh([cliPath(), "setup"], { cwd: repo, env }).code;
    bareCode = fx.sh([cliPath(), "new"], { cwd: repo, env }).code;
    // A PATH holding bun and nothing else: there is no claude to open.
    const bin = fx.p("only-bun");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "bun"));
    const r = fx.sh([process.execPath, cliPath(), "setup"], { cwd: repo, env: { ...env, PATH: bin } });
    missing = { code: r.code, err: r.err };
  });

  test("it runs claude interactively in the current directory", () => {
    expect(setupCode).toBe(0);
    expect(read(join(S, "cwd.setup.1")).trim()).toBe(repo);
    expect(lines(join(S, "argv.setup.1"))).not.toContain("-p");
  });
  test("with the skill from this checkout, and the CLI's path in the first message", () => {
    expect(after(join(S, "argv.setup.1"), "--append-system-prompt-file")).toEqual([join(ROOT, "skills/ralph-new/SKILL.md")]);
    expect(lines(join(S, "argv.setup.1")).at(-1)).toContain(join(ROOT, "bin/ralph"));
  });
  test("ralph new with no arguments does the same", () => {
    expect(bareCode).toBe(0);
    expect(read(join(S, "argv.setup.2"))).toBe(read(join(S, "argv.setup.1")));
  });
  test("without claude on PATH it says so and fails", () => {
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("claude is not on PATH");
  });
});
