import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import {
  Fx,
  cliPath,
  join,
  loopArgv,
  patchConfig,
  read,
  readConfigValue,
  setup,
  sleeperGone,
  statuses,
  TEMPLATE_CONFIG,
  until,
  writeConfig,
  ROOT,
} from "../helpers/index.ts";

const fx = new Fx("cli");
const T = fx.T;

// What a scaffolded loop is patched with so it runs one quick iteration: no
// sleeps, no push, no reviewer.
const TAME = { QUIET_SLEEP: 0, STEP_SLEEP: 0, ERROR_SLEEP: 0, PUSH: false, REVIEW: false, MAX_ITER: 1 };

/** stdout and stderr together, the way `2>&1` hands them over. */
const both = (r: { out: string; err: string }) => r.out + r.err;

/** Every newline in a file: what `wc -l` counts. */
const newlines = (text: string) => (text.match(/\n/g) ?? []).length;

/** The last line, as `tail -1` prints it. */
const lastLine = (text: string) => text.replace(/\n$/, "").split("\n").pop() ?? "";

/** A template as `ralph new` fills it: the quoted JSON placeholder before the short one. */
function filled(text: string, name: string, repo: string): string {
  return text
    .split('"__SCHEMA_JSON__"')
    .join(JSON.stringify(`file://${join(ROOT, "template/config.schema.json")}`))
    .split('"__REPO_JSON__"')
    .join(JSON.stringify(repo))
    .split("__REPO__")
    .join(repo)
    .split("__NAME__")
    .join(name);
}

/** Wait until the loop has logged its end, then until `ralph status` agrees. */
async function waitStopped(home: string, name: string): Promise<void> {
  await until(() => read(join(home, name, "ralph.log")).includes("ralph finished"), 30);
  await until(() => fx.cli(home, ["status", name]).out.includes("stopped"), 20);
}

describe("CLI: new, start, status, steer, results, stop", () => {
  const app = fx.p("app-d");
  const remote = fx.p("remote-d.git");
  const home = fx.p("home");
  const loop = join(home, "demo");
  let S = "";
  let scaffolded = false;
  let repoBack: string | undefined;
  let runningStatus = "";
  let secondRefused = false;
  let steerFile = "";
  let promptFile = "";
  let stoppedStatus = "";
  let lockLeft = true;
  let results = "";
  let statusAfter = "";
  let review = "";
  let bare = "";

  setup(async () => {
    fx.makeRepo(app, remote);
    S = fx.stub("stub-d", ["sleep"]);
    fx.cli(home, ["new", "demo", app]);
    scaffolded = existsSync(join(loop, "config.json"));
    repoBack = readConfigValue(join(loop, "config.json"), "REPO");
    patchConfig(loop, { QUIET_SLEEP: 0, STEP_SLEEP: 0, ERROR_SLEEP: 0, ITER_TIMEOUT: 600, REVIEW: false, PUSH: false });
    fx.cli(home, ["start", "demo"], { STUB_DIR: S });
    try {
      // The agent is in its sleep once it has taken its mode and recorded the sleeper.
      await until(() => read(join(S, "modes.done")) !== "" && read(join(S, "sleeper.pid")).trim() !== "", 10);
      runningStatus = fx.cli(home, ["status", "demo"]).out;
      // A second loop on the same directory. Run with a ceiling, so one that is
      // not refused cannot hold the file up; being killed by it is not a refusal.
      const second = Bun.spawnSync(loopArgv(loop), {
        env: fx.env(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      });
      secondRefused = second.exitCode !== null && second.exitCode !== 0 && !second.signalCode;
      fx.cli(home, ["steer", "demo", "look at the login flow first"]);
      steerFile = read(join(loop, "STEER.md"));
      promptFile = read(join(loop, "PROMPT.md"));
    } finally {
      fx.cli(home, ["stop", "demo"]);
    }
    stoppedStatus = fx.cli(home, ["status", "demo"]).out;
    lockLeft = existsSync(join(loop, "ralph.lock"));
    writeFileSync(
      join(loop, "results.tsv"),
      [
        "time\titer\tbefore\tafter\tstatus\tsecs\treason\tcost_usd\ttokens",
        "2026-01-01 10:00:00\t1\t0123456789ab\t1123456789ab\tkeep\t12\t-\t0.0123\t150",
        "2026-01-01 10:05:00\t2\t1123456789ab\t2123456789ab\trevert:verify\t9\tverify failed\t0.0123\t150",
        "2026-01-01 10:10:00\t3\t1123456789ab\t1123456789ab\tquiet\t4\t-\t0.0123\t150",
        "2026-01-01 10:15:00\t4\t1123456789ab\t3123456789ab\tkeep\t15\t-\t0.0123\t150",
        "",
      ].join("\n"),
    );
    results = fx.cli(home, ["results", "demo"]).out;
    statusAfter = fx.cli(home, ["status", "demo"]).out;
    fx.git(fx.p("app-d-ralph-demo"), "commit", "-q", "--allow-empty", "-m", "stub: waiting for a human");
    review = fx.cli(home, ["review", "demo"]).out;
    bare = fx.cli(home, []).out;
  });

  test("ralph new scaffolds the loop", () => {
    expect(scaffolded).toBe(true);
  });
  test("ralph new fills in the repo path", () => {
    expect(repoBack).toBe(app);
  });
  test("the loop is running", () => {
    expect(runningStatus).toContain("running");
  });
  test("status shows the worktree", () => {
    expect(runningStatus).toContain("ralph/demo");
  });
  test("a second loop on the same directory is refused", () => {
    expect(secondRefused).toBe(true);
  });
  test("steer reaches the running iteration (STEER.md)", () => {
    expect(steerFile).toContain("login flow");
  });
  test("steer holds for later iterations (PROMPT.md)", () => {
    expect(promptFile).toContain("login flow");
  });
  test("stop ends the loop", () => {
    expect(stoppedStatus).toContain("stopped");
  });
  test("stop kills the agent's process group", () => {
    expect(sleeperGone(join(S, "sleeper.pid"))).toBe(true);
  });
  test("the loop logged why it stopped", () => {
    expect(read(join(loop, "ralph.log"))).toContain("stopped by signal");
  });
  test("the lock is released", () => {
    expect(lockLeft).toBe(false);
  });
  test("ralph results renders a table", () => {
    expect(results.split("\n")[0]).toContain("status");
  });
  test("status counts the verdicts", () => {
    expect(statusAfter).toMatch(/verdicts.*keep/);
  });
  test("review lists what waits on ralph/<name> for a merge", () => {
    const at = review.indexOf("Waiting to merge");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(review.slice(at)).toContain("stub: waiting for a human");
  });
  test("bare ralph prints the guide and lists your loops", () => {
    expect(bare).toContain("Getting started");
    expect(bare).toContain("Your loops: demo");
  });
});

describe("CLI: usage, and a status with nothing to show", () => {
  const home = fx.p("home-f");
  let bare = "";
  let statusAll = "";
  let statusNosuch = "";
  let statusLogged = "";

  setup(() => {
    mkdirSync(join(home, "notaloop"), { recursive: true });
    bare = fx.cli(home, []).out;
    statusAll = fx.cli(home, ["status"]).out;
    statusNosuch = fx.cli(home, ["status", "nosuch"]).out;

    // grep -c prints 0 and exits 1 when it matches nothing, so a `|| echo 0`
    // fallback used to add a second 0 and split the line.
    const app = fx.p("app-f");
    fx.makeRepo(app, fx.p("remote-f.git"));
    const logged = join(home, "logged");
    mkdirSync(logged);
    writeConfig(logged, { REPO: app });
    writeFileSync(join(logged, "ralph.log"), "[2026-01-01 10:00] === iteration 1 ===\n");
    statusLogged = fx.cli(home, ["status", "logged"]).out;
  });

  test("bare ralph prints the usage instead of running status", () => {
    expect(bare).toContain("ralph stop <name>");
  });
  test("status says so when it recognises no loops", () => {
    expect(statusAll).toContain("no loops");
  });
  test("status of a name that is not a loop says so", () => {
    expect(statusNosuch).toContain("no loop");
  });
  test("iteration counts stay on one line when nothing shipped yet", () => {
    expect(statusLogged).toContain("1 run, 0 shipped a commit");
  });
});

describe("CLI through a symlink on PATH", () => {
  const home = fx.p("home-e");
  let absolute = -1;
  let relativeHelp = "";

  setup(() => {
    mkdirSync(fx.p("bin"));
    mkdirSync(fx.p("deep/bin"), { recursive: true });
    symlinkSync(cliPath(), fx.p("bin/ralph")); // absolute link
    symlinkSync("../../bin/ralph", fx.p("deep/bin/ralph")); // relative link to a link
    const app = fx.p("app-e");
    fx.makeRepo(app, fx.p("remote-e.git"));
    absolute = fx.sh([fx.p("bin/ralph"), "new", "viasymlink", app], { env: { RALPH_HOME: home } }).code;
    relativeHelp = fx.sh([fx.p("deep/bin/ralph"), "help"]).out;
  });

  test("an absolute symlink finds the harness", () => {
    expect(absolute).toBe(0);
  });
  test("the loop it scaffolds comes from the real template", () => {
    expect(existsSync(join(home, "viasymlink/PROMPT.md"))).toBe(true);
  });
  test("a relative chain of symlinks finds the harness", () => {
    expect(relativeHelp).toContain("ralph new");
  });
});

describe("ralph new writes the path it was given, not sed's reading of it", () => {
  // The template was filled in with sed, which reads the value it is handed as
  // syntax. Three characters a directory may legally hold broke it, all
  // silently, all after "created <dir>": & means the whole match in a
  // replacement, | ended the s/// early, and a backslash escaped whatever
  // followed it.
  const home = fx.p("home-scaf");
  const amp = fx.p("r&d-scaf");
  const pipe = fx.p("p|q-scaf");
  const esc = fx.p("back\\slash-scaf");
  const app = fx.p("app-scaf");
  // What the loop receives, rather than what the line looks like.
  const scafRepo = (name: string) => readConfigValue(join(home, name, "config.json"), "REPO");

  setup(async () => {
    const S = fx.stub("stub-scaf", ["commit"]);
    fx.makeRepo(amp, fx.p("remote-scaf1.git"));
    fx.cli(home, ["new", "amp", amp]);
    patchConfig(join(home, "amp"), TAME);
    await fx.runLoop(join(home, "amp"), S);

    fx.makeRepo(pipe, fx.p("remote-scaf2.git"));
    fx.cli(home, ["new", "pipe", pipe]);

    fx.makeRepo(esc, fx.p("remote-scaf3.git"));
    fx.cli(home, ["new", "esc", esc]);

    // The loop's own name goes through the same substitution, into PROMPT.md as
    // well as the config.
    fx.makeRepo(app, fx.p("remote-scaf4.git"));
    fx.cli(home, ["new", "a&b", app]);

    fx.cli(home, ["new", "plain", app]);
  });

  test("an & in the repo path reaches config.json whole", () => {
    expect(scafRepo("amp")).toBe(amp);
  });
  test("and the loop it scaffolded runs and keeps its commit", () => {
    expect(statuses(join(home, "amp"))).toBe("keep");
  });
  test("a | in the repo path does not leave config.json empty", () => {
    expect(scafRepo("pipe")).toBe(pipe);
  });
  test("a backslash in the repo path is not eaten", () => {
    expect(scafRepo("esc")).toBe(esc);
  });
  test("an & in the loop name reaches PROMPT.md whole", () => {
    expect(read(join(home, "a&b/PROMPT.md"))).toContain("a&b");
  });

  // Guards. A fill that wrote nothing, or dropped the lines it could not read,
  // would satisfy every check above, so pin that an ordinary loop is scaffolded
  // exactly as the template reads.
  test("an ordinary loop keeps every line of the template", () => {
    const got = read(join(home, "plain", "config.json"));
    expect(got).not.toBe("");
    expect(newlines(got)).toBe(newlines(read(TEMPLATE_CONFIG)));
  });
  test("with no placeholder left behind", () => {
    expect(read(join(home, "plain", "config.json"))).not.toMatch(/__[A-Z_]*__/);
    expect(read(join(home, "plain/PROMPT.md"))).not.toMatch(/__[A-Z_]*__/);
  });
  test("and its last line intact", () => {
    const got = lastLine(read(join(home, "plain", "config.json")));
    expect(got).toBe(lastLine(filled(read(TEMPLATE_CONFIG), "plain", app)));
  });
});

describe("ralph new --set writes settings into config.json", () => {
  // The way a setup that asked its questions first scaffolds a loop: every
  // value through JSON.stringify, judged before anything is written.
  const home = fx.p("home-set");
  const app = fx.p("app-set");
  let made = { code: -1, out: "", err: "" };
  let text = "";
  let cfg: Record<string, unknown> = {};
  const refused: Record<string, { code: number; out: string; err: string }> = {};

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-set.git"));
    made = fx.cli(home, [
      "new", "set", app,
      "--set", "PUSH=pr",
      "--set", "PR_MERGE=true",
      "--set", 'VERIFY_CMD=bun test && echo "$& \\ done"',
      "--set=MAX_ITER=40",
      "--set", "WORKTREE_DIR=/tmp/ralph-set-wt",
      "--set", "PR_MERGE_POLL=5",
      "--set", 'CLOSING="Go."',
      "--set", 'FROZEN=["a b","c"]',
    ]);
    text = read(join(home, "set", "config.json"));
    cfg = Bun.JSONC.parse(text) as Record<string, unknown>;
    for (const [what, args] of Object.entries({
      unknown: ["--set", "MAX_ITERS=3"],
      type: ["--set", "MAX_ITER=forty"],
      method: ["--set", "PR_MERGE_METHOD=fast"],
      repo: ["--set", "REPO=/elsewhere"],
      flag: ["--push", "pr"],
      bare: ["--set", "NOEQUALS"],
    })) {
      refused[what] = fx.cli(home, ["new", `no-${what}`, app, ...args]);
    }
  });

  test("it scaffolds, and lists what it set", () => {
    expect(made.code).toBe(0);
    expect(made.out).toContain('PUSH = "pr"');
    expect(made.out).toContain("PR_MERGE = true");
  });
  test("each value reads back as given: JSON where it is JSON, a string where it is not", () => {
    expect(cfg).toMatchObject({
      PUSH: "pr",
      PR_MERGE: true,
      VERIFY_CMD: 'bun test && echo "$& \\ done"',
      MAX_ITER: 40,
      WORKTREE_DIR: "/tmp/ralph-set-wt",
      PR_MERGE_POLL: 5,
      CLOSING: "Go.",
      FROZEN: ["a b", "c"],
      REPO: app,
    });
  });
  test("the documentation stays beside each setting", () => {
    expect(text).toContain("// The branch the worktree starts from");
    expect(text).toContain("// With PUSH \"pr\": once the loop ends by itself");
  });
  test("a setting the template had commented out is set, once", () => {
    expect(text.split("\n").filter((l) => l.includes('"WORKTREE_DIR"'))).toEqual(['  "WORKTREE_DIR": "/tmp/ralph-set-wt",']);
  });
  test("and one after the template's last setting, and one it never had, still parse", () => {
    expect(text).toContain('"LIVE_STEER": true,');
    expect(text).toContain('  "PR_MERGE_POLL": 5,\n}');
  });
  for (const what of ["unknown", "type", "method", "repo", "flag", "bare"]) {
    test(`a refused --set (${what}) leaves no loop behind`, () => {
      expect(refused[what]!.code).not.toBe(0);
      expect(existsSync(join(home, `no-${what}`))).toBe(false);
    });
  }
  test("and the refusal says what was wrong", () => {
    expect(both(refused.unknown!)).toContain("MAX_ITERS is not a setting");
    expect(both(refused.type!)).toContain("MAX_ITER must be a whole number");
    expect(both(refused.method!)).toContain('"merge", "squash" or "rebase"');
    expect(both(refused.repo!)).toContain("REPO is the <repo-path> argument");
    expect(both(refused.flag!)).toContain('not "--push"');
  });
});

describe("ralph new refuses a name the harness cannot use", () => {
  // WORKTREE=1 is the template's default, and it puts the loop on branch
  // ralph/<name>. A name git will not take as a branch component therefore
  // scaffolds a loop that can never start.
  const home = fx.p("home-name");
  const app = fx.p("app-name");
  let spaceRc = 0;
  let spaceOut = "";
  let dotsRc = 0;
  let slashRc = 0;
  let slashDir = true;
  let plainRc = -1;
  let dotRc = -1;
  let status = "";
  let afileRc = 0;
  let afileOut = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-name.git"));
    const space = fx.cli(home, ["new", "my loop", app]);
    spaceRc = space.code;
    spaceOut = both(space);
    dotsRc = fx.cli(home, ["new", "a..b", app]).code;
    slashRc = fx.cli(home, ["new", "a/b", app]).code;
    slashDir = existsSync(join(home, "a"));
    plainRc = fx.cli(home, ["new", "plain-name", app]).code;
    dotRc = fx.cli(home, ["new", "plain.name", app]).code;
    status = fx.cli(home, ["status"]).out;

    // $RALPH_HOME under a regular file: a loop directory mkdir cannot make.
    writeFileSync(fx.p("afile-name"), "");
    const afile = fx.cli(fx.p("afile-name/sub"), ["new", "plain", app]);
    afileRc = afile.code;
    afileOut = afile.out;

    const S = fx.stub("stub-name", ["commit"]);
    patchConfig(join(home, "plain.name"), TAME);
    await fx.runLoop(join(home, "plain.name"), S);
  });

  test("a name with a space is refused", () => {
    expect(spaceRc).not.toBe(0);
  });
  test("and nothing is left behind for it", () => {
    expect(existsSync(join(home, "my loop"))).toBe(false);
  });
  test("the refusal names the loop name and says that is what is wrong", () => {
    expect(spaceOut).toContain("loop name");
    expect(spaceOut).toContain("my loop");
  });
  test("a name with .. in it is refused", () => {
    expect(dotsRc).not.toBe(0);
  });
  test("a name with a / is refused", () => {
    expect(slashRc).not.toBe(0);
  });
  test("and no directory is made for its first component", () => {
    expect(slashDir).toBe(false);
  });
  test("an ordinary name still scaffolds", () => {
    expect(plainRc).toBe(0);
  });
  test("a dot inside a name still scaffolds", () => {
    expect(dotRc).toBe(0);
  });
  test("and ralph status lists what was scaffolded", () => {
    expect(status).toContain("plain-name");
  });
  test("a loop directory it could not make is not a loop", () => {
    expect(afileRc).not.toBe(0);
  });
  test("and it does not say it created one", () => {
    expect(afileOut).not.toContain("created");
  });
  test("and a name with a dot runs on its own branch and keeps its commit", () => {
    expect(statuses(join(home, "plain.name"))).toBe("keep");
  });
});

describe("the commands ralph prints back are ones a shell will run", () => {
  // git takes plenty that a shell reads as syntax: & ; | ( ) $ ` and both quotes
  // are all legal in a branch name. So `ralph new 'a&b'` scaffolded a loop that
  // works and then told the user `3. ralph start a&b`, which pastes into a shell
  // as `ralph start a` in the background, then `b`.
  const app = fx.p("app-hint");
  const home = fx.p("home-hint");
  const shim = fx.p("shim-hint");
  const pastedFile = fx.p("pasted-hint");
  let newHint = "";
  let startHint = "";
  let reviewHint = "";
  let shipped = "";
  let mergedHead = "";
  let lookCloser = "";
  let plainHint = "";
  let quoteHint = "";

  /** That command as ralph printed it, colour escapes and the prose around it removed. */
  const printed = (output: string, prefix: string): string => {
    const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
    const at = plain.indexOf(`${prefix} `);
    if (at < 0) return "";
    const word = plain.slice(at + prefix.length + 1).match(/^[^ \n]*/)?.[0] ?? "";
    return `${prefix} ${word}`;
  };
  /** The rest of the line after the prose in front of the command. */
  const after = (output: string, prose: string): string => {
    const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
    for (const line of plain.split("\n")) {
      const at = line.lastIndexOf(prose);
      if (at >= 0) return line.slice(at + prose.length);
    }
    return "";
  };
  /** Run a command the way a user pasting it would, through the recording shim. */
  const pasted = (command: string): string => {
    writeFileSync(pastedFile, "");
    fx.sh(["bash", "-c", `${command}\nwait`], { env: { PASTED: pastedFile, PATH: `${shim}:${fx.env().PATH}` } });
    return read(pastedFile).split("\n").join(" ");
  };

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-hint.git"));
    // A `ralph` that records nothing but the arguments it was handed, one line
    // per call, so what is checked is what the shell passed on.
    mkdirSync(shim);
    writeFileSync(join(shim, "ralph"), '#!/bin/sh\nprintf "%s|%s\\n" "$#" "$*" >> "$PASTED"\n');
    chmodSync(join(shim, "ralph"), 0o755);

    newHint = fx.cli(home, ["new", "a&b", app]).out;

    const S = fx.stub("stub-hint", ["commit"]);
    patchConfig(join(home, "a&b"), TAME);
    startHint = fx.cli(home, ["start", "a&b"], { STUB_DIR: S }).out;
    await waitStopped(home, "a&b");
    reviewHint = both(fx.cli(home, ["review", "a&b"]));

    // With PUSH=0 the loop's commits sit on ralph/<name> until the human merges
    // them, so the merge line is run for real: the claim is that it merges.
    shipped = fx.git(app, "rev-parse", "ralph/a&b");
    fx.sh(["bash", "-c", `${after(reviewHint, "merge them: ")}\nwait`]);
    mergedHead = fx.git(app, "rev-parse", "HEAD");
    const look = after(reviewHint, "look closer: ").replace(/ show <sha>.*/, " show");
    lookCloser = fx.sh(["bash", "-c", `${look} ${shipped} --no-patch --format=%s`]).out;

    plainHint = fx.cli(home, ["new", "plainhint", app]).out;
    quoteHint = fx.cli(home, ["new", "a'b", app]).out;
  });

  test("the hint ralph new prints starts the loop it just made", () => {
    expect(pasted(printed(newHint, "ralph start"))).toBe("2|start a&b ");
  });
  test("and the loop it named really did run and kept a commit", () => {
    expect(statuses(join(home, "a&b"))).toBe("keep");
  });
  for (const verb of ["status", "tail", "stop"]) {
    test(`the ${verb} hint ralph start prints names that loop and nothing else`, () => {
      expect(pasted(printed(startHint, `ralph ${verb}`))).toBe(`2|${verb} a&b `);
    });
  }
  test("the hint ralph review prints reaches that loop's verdicts", () => {
    expect(pasted(printed(reviewHint, "ralph results"))).toBe("2|results a&b ");
  });
  test("the merge command ralph review prints really merges that loop's branch", () => {
    expect(shipped).not.toBe("");
    expect(mergedHead).toBe(shipped);
  });
  // The path in the other half of the footer is the worktree's, and it holds the
  // loop name too: this stops a fix that quotes the name and leaves the path
  // hand-quoted.
  test("and the 'look closer' command it prints shows a commit from the worktree", () => {
    expect(lookCloser).toContain("stub: work");
  });
  // Guards. Quoting every name would satisfy all of the above and make the
  // common hint unreadable, so pin that a name needing nothing is still printed
  // bare — and that a name holding a quote survives, which '' would not.
  test("a name that needs no quoting is still printed bare", () => {
    expect(printed(plainHint, "ralph start")).toBe("ralph start plainhint");
  });
  test("a name holding a single quote is quoted so the shell hands it back whole", () => {
    expect(pasted(printed(quoteHint, "ralph start"))).toBe("2|start a'b ");
  });
});
