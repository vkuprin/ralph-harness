import { describe, expect } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { Fx, ROOT, hookArgv, join, read, setup, statuses, tsOnly, waitProc } from "../helpers/index.ts";

// Behaviour the TypeScript harness has and the bash one did not: config.json,
// its refusals, and `ralph migrate` from config.sh.

const fx = new Fx("typescript");
const ESC = /\x1b\[[0-9;]*m/g;

/** A loop directory with the template's PROMPT.md and PROGRESS.md and `config` as config.json. */
function loopWith(dir: string, config: string, file = "config.json"): void {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(ROOT, "template/PROMPT.md"), join(dir, "PROMPT.md"));
  copyFileSync(join(ROOT, "template/PROGRESS.md"), join(dir, "PROGRESS.md"));
  writeFileSync(join(dir, file), config);
}

describe("a config.json the harness cannot read refuses the start", () => {
  const app = fx.p("app-cfg");
  const runs: Record<string, { code: number; log: string }> = {};

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-cfg.git"));
    const cases: Record<string, string> = {
      unknown: `{ "REPO": ${JSON.stringify(app)}, "MAX_ITERS": 3 }`,
      type: `{ "REPO": ${JSON.stringify(app)}, "MAX_ITER": "3" }`,
      relative: `{ "REPO": "code/app" }`,
      regex: `{ "REPO": ${JSON.stringify(app)}, "RATE_LIMIT_EXTRA_RE": "(" }`,
    };
    for (const [name, text] of Object.entries(cases)) {
      const dir = fx.p("loops", `cfg-${name}`);
      loopWith(dir, text);
      const code = await fx.runLoop(dir, fx.stub(`stub-cfg-${name}`, ["commit"]));
      runs[name] = { code, log: read(join(dir, "ralph.log")) };
    }
  });

  tsOnly("a key the harness does not know", () => {
    expect(runs.unknown!.code).toBe(2);
    expect(runs.unknown!.log).toContain("MAX_ITERS is not a setting this harness knows");
  });
  tsOnly("a value of the wrong type", () => {
    expect(runs.type!.code).toBe(2);
    expect(runs.type!.log).toContain("MAX_ITER must be a whole number");
  });
  tsOnly("a REPO that is not an absolute path", () => {
    expect(runs.relative!.code).toBe(2);
    expect(runs.relative!.log).toContain("REPO must be an absolute path");
  });
  tsOnly("a limit pattern that does not compile", () => {
    expect(runs.regex!.code).toBe(2);
    expect(runs.regex!.log).toContain("RATE_LIMIT_EXTRA_RE must be a regular expression");
  });
  tsOnly("and none of them ran an iteration", () => {
    for (const r of Object.values(runs)) expect(r.log).not.toContain("=== iteration");
  });
});

describe("a loop still on config.sh is sent to ralph migrate", () => {
  const home = fx.p("home-sh");
  const dir = join(home, "a&b");
  let loop = { code: -1 };
  let start = { code: -1, err: "" };
  let status = "";
  let review = { code: -1, err: "" };

  setup(async () => {
    loopWith(dir, `REPO=${fx.p("app-cfg")}\nMAX_ITER=1\n`, "config.sh");
    loop = { code: await fx.runLoop(dir, fx.stub("stub-sh", ["commit"])) };
    const s = fx.cli(home, ["start", "a&b"]);
    start = { code: s.code, err: s.err };
    status = fx.cli(home, ["status"]).out.replace(ESC, "");
    const r = fx.cli(home, ["review", "a&b"]);
    review = { code: r.code, err: r.err };
  });

  tsOnly("the loop refuses to start, and says how to convert it", () => {
    expect(loop.code).toBe(2);
    expect(read(join(dir, "ralph.log"))).toContain("convert them: ralph migrate a&b");
  });
  tsOnly("ralph start refuses with a hint that can be pasted", () => {
    expect(start.code).not.toBe(0);
    expect(start.err).toContain("ralph migrate 'a&b'");
  });
  tsOnly("ralph status lists it, with the same hint", () => {
    expect(status).toContain("a&b");
    expect(status).toContain("ralph migrate 'a&b'");
  });
  tsOnly("ralph review sends it to migrate instead of denying it exists", () => {
    expect(review.code).not.toBe(0);
    expect(review.err).toContain("ralph migrate 'a&b'");
  });
});

describe("ralph migrate turns config.sh into config.json", () => {
  const home = fx.p("home-mig");
  const app = fx.p("app-mig");
  const dir = join(home, "legacy");
  const busy = join(home, "busy");
  const bad = join(home, "bad");
  let migrated = { code: -1, out: "" };
  let twice = { code: -1 };
  let running = { code: -1, err: "" };
  let refused = { code: -1, err: "" };
  let code = -1;
  let converted: Record<string, unknown> = {};

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-mig.git"));
    loopWith(
      dir,
      `# Settings for the legacy loop.
REPO=${app}
MAX_ITER=3 QUIET_SLEEP=0 STEP_SLEEP=0 ERROR_SLEEP=0
WORKTREE=1
FROZEN=("measure.sh")
NOTIFY_CMD='osascript -e '\\''display notification (system attribute "RALPH_MESSAGE")'\\'''
RATE_LIMIT_RE="$RATE_LIMIT_RE|quota window closed"
`,
      "config.sh",
    );
    const m = fx.cli(home, ["migrate", "legacy"]);
    migrated = { code: m.code, out: m.out.replace(ESC, "") };
    twice = { code: fx.cli(home, ["migrate", "legacy"]).code };
    // The loop's own notifier would pop up on this machine; the test does not
    // need it, and a config written by migrate is still a config to edit.
    converted = Bun.JSONC.parse(read(join(dir, "config.json"))) as Record<string, unknown>;
    const cfg = { ...converted, NOTIFY_CMD: "" };
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
    code = await fx.runLoop(dir, fx.stub("stub-mig", ["commit", "commit", "commit", "commit", "commit"]));

    // A bash-era loop still running on the directory: its command line names
    // ralph.sh and ends with the loop directory.
    loopWith(busy, `REPO=${app}\n`, "config.sh");
    const p = Bun.spawn(["bash", "-c", "while :; do sleep 0.2; done", join(fx.T, "ralph.sh"), busy], { stdout: "ignore", stderr: "ignore" });
    await waitProc(p.pid, busy);
    writeFileSync(join(busy, "ralph.pid"), `${p.pid}\n`);
    const r = fx.cli(home, ["migrate", "busy"]);
    running = { code: r.code, err: r.err };
    p.kill("SIGKILL");

    loopWith(bad, `REPO="$HOME/app"\n`, "config.sh");
    const b = fx.cli(home, ["migrate", "bad"]);
    refused = { code: b.code, err: b.err };
  });

  tsOnly("it converts a stopped loop and keeps the old file beside it", () => {
    expect(migrated.code).toBe(0);
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(existsSync(join(dir, "config.sh.old"))).toBe(true);
    expect(existsSync(join(dir, "config.sh"))).toBe(false);
  });
  tsOnly("every setting comes across as the value bash read", () => {
    expect(converted).toEqual({
      REPO: app,
      MAX_ITER: 3,
      QUIET_SLEEP: 0,
      STEP_SLEEP: 0,
      ERROR_SLEEP: 0,
      WORKTREE: true,
      FROZEN: ["measure.sh"],
      NOTIFY_CMD: `osascript -e 'display notification (system attribute "RALPH_MESSAGE")'`,
      RATE_LIMIT_EXTRA_RE: "quota window closed",
    });
    expect(migrated.out).toContain("migrated legacy");
  });
  tsOnly("the migrated loop runs, and stops at the MAX_ITER it carried over", () => {
    expect(code).toBe(0);
    expect(statuses(dir)).toBe("keep keep keep");
    expect(read(join(dir, "ralph.log"))).toContain("hit MAX_ITER=3");
  });
  tsOnly("migrating twice is refused", () => {
    expect(twice.code).not.toBe(0);
  });
  tsOnly("migrate refuses while the old loop is running", () => {
    expect(running.code).not.toBe(0);
    expect(running.err).toContain("is running as PID");
    expect(existsSync(join(busy, "config.json"))).toBe(false);
  });
  tsOnly("a line it would have to evaluate is refused, and named", () => {
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain('REPO="$HOME/app"');
    expect(existsSync(join(bad, "config.json"))).toBe(false);
    expect(existsSync(join(bad, "config.sh"))).toBe(true);
  });
});

describe("the steer hook takes the file whole", () => {
  const dir = fx.p("hook");
  const steer = join(dir, "STEER.md");
  let first = "";
  let second = "";

  setup(() => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(steer, "one\n");
    first = fx.sh(hookArgv(), { env: { RALPH_STEER_FILE: steer } }).out;
    writeFileSync(steer, "two\n", { flag: "a" });
    second = fx.sh(hookArgv(), { env: { RALPH_STEER_FILE: steer } }).out;
  });

  tsOnly("it answers with PreToolUse's deny, the steer as the reason the model reads", () => {
    const j = JSON.parse(first);
    expect(j.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(j.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(j.hookSpecificOutput.permissionDecisionReason).toContain("OPERATOR STEERING (from ralph steer): one");
  });
  tsOnly("a steer sent after the first delivery is delivered at the next call, alone", () => {
    const r = JSON.parse(second).hookSpecificOutput.permissionDecisionReason;
    expect(r).toContain("two");
    expect(r).not.toContain("one");
  });
  tsOnly("both reach the reviewer's record, and nothing is left half-taken", () => {
    expect(read(`${steer}.delivered`)).toBe("one\ntwo\n");
    expect(readdirSync(dir).filter((f) => f.includes(".taking."))).toEqual([]);
  });
});
