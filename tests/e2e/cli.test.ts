import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
  Fx,
  IS_WIN,
  alive,
  cliPath,
  join,
  loopArgv,
  patchConfig,
  read,
  readConfigValue,
  setup,
  sleeperGone,
  statuses,
  term,
  TEMPLATE_CONFIG,
  until,
  writeConfig,
  waitProc,
  sq,
  ROOT,
} from "../helpers/index.ts";

const fx = new Fx("cli");

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
  let version = "";

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
    version = fx.cli(home, ["--version"]).out;
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
  test("--version prints the version package.json ships with", () => {
    expect(version).toBe(`ralph ${(JSON.parse(read(join(ROOT, "package.json"))) as { version: string }).version}\n`);
  });
});

// A reader that has read enough closes the pipe: `head -1`, `grep -q`, a pager
// the human quits. That once ended the CLI with a stack trace and exit status 1,
// after it had done its work, so `ralph status | grep -q running` under
// pipefail called a running loop not running. Here the reader has closed the
// pipe before the CLI starts, so every write meets a broken pipe and none can
// slip into the pipe's buffer first. Not on Windows, where nobody has watched
// what a broken pipe from Git Bash looks like to bun.
describe.skipIf(IS_WIN)("a reader that stops reading ends the CLI quietly, with its own exit status", () => {
  const home = fx.p("home-pipe");
  const app = fx.p("app-pipe");
  const ran = new Map<string, { code: number; err: string }>();
  const cases = [
    ["status"],
    ["status", "piped"],
    ["results", "piped"],
    ["review", "piped"],
    ["log", "piped"],
    ["help"],
    ["new", "fresh", app],
    ["results", "nosuch"],
  ];

  /** The CLI writing into a pipe its reader has already closed: its exit status and stderr. */
  const closedReader = (args: string[]) => {
    const flag = fx.p(`pipe-closed-${ran.size}`);
    const err = fx.p(`pipe-err-${ran.size}`);
    const script = `{ while [ ! -e "$1" ]; do sleep 0.05; done; shift 2; "$@"; } 2>"$2" | { exec 0<&-; : >"$1"; }
echo "\${PIPESTATUS[0]}"`;
    const r = fx.sh(["bash", "-c", script, "_", flag, err, cliPath(), ...args], { env: { RALPH_HOME: home } });
    return { code: Number(r.out.trim()), err: read(err) };
  };

  setup(() => {
    fx.makeRepo(app, fx.p("remote-pipe.git"));
    const loop = join(home, "piped");
    mkdirSync(loop, { recursive: true });
    writeConfig(loop, { REPO: app });
    writeFileSync(join(loop, "ralph.log"), "[2026-01-01 10:00] === iteration 1 ===\n".repeat(100));
    const head = fx.git(app, "rev-parse", "HEAD");
    writeFileSync(
      join(loop, "results.tsv"),
      `time\titer\tbefore\tafter\tstatus\tsecs\treason\n${`2026-01-01 10:00:00\t1\t${head}\t${head}\tkeep\t3\t-\n`.repeat(100)}`,
    );
    for (const args of cases) ran.set(args.join(" "), closedReader(args));
  });

  for (const args of cases.slice(0, -1)) {
    const label = args.slice(0, 2).join(" ");
    test(`ralph ${label} exits 0 and prints no error`, () => {
      expect(ran.get(args.join(" "))).toEqual({ code: 0, err: "" });
    });
  }
  test("ralph new still made the loop nobody read about", () => {
    expect(existsSync(join(home, "fresh/config.json"))).toBe(true);
  });
  // Guard: a fix that sets every exit status to 0 would pass all of the above.
  test("a command that fails still says so, on stderr, with status 1", () => {
    const r = ran.get("results nosuch")!;
    expect(r.code).toBe(1);
    expect(r.err).toContain("no results yet for nosuch");
  });
});

// Windows makes a symlink only with Developer Mode or as an administrator, and
// installs the CLI as npm's ralph.cmd, which runs bin/ralph with bun, instead.
describe.skipIf(IS_WIN)("CLI through a symlink on PATH", () => {
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

    // Neither | nor a backslash can be in a directory name on Windows.
    if (!IS_WIN) {
      fx.makeRepo(pipe, fx.p("remote-scaf2.git"));
      fx.cli(home, ["new", "pipe", pipe]);

      fx.makeRepo(esc, fx.p("remote-scaf3.git"));
      fx.cli(home, ["new", "esc", esc]);
    }

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
  test.skipIf(IS_WIN)("a | in the repo path does not leave config.json empty", () => {
    expect(scafRepo("pipe")).toBe(pipe);
  });
  test.skipIf(IS_WIN)("a backslash in the repo path is not eaten", () => {
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

  setup(() => {
    fx.makeRepo(app, fx.p("remote-set.git"));
    made = fx.cli(home, [
      "new",
      "set",
      app,
      "--set",
      "PUSH=pr",
      "--set",
      "PR_MERGE=true",
      "--set",
      'VERIFY_CMD=bun test && echo "$& \\ done"',
      "--set=MAX_ITER=40",
      "--set",
      "WORKTREE_DIR=/tmp/ralph-set-wt",
      "--set",
      "PR_MERGE_POLL=5",
      "--set",
      'CLOSING="Go."',
      "--set",
      'FROZEN=["a b","c"]',
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
      // Each compiles alone; joined by | they do not.
      limits: ["--set", "RATE_LIMIT_RE=(?<x>limit)", "--set", "RATE_LIMIT_EXTRA_RE=\\k<y>"],
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
    expect(text).toContain('// With PUSH "pr": once the loop ends by itself');
  });
  test("a setting the template had commented out is set, once", () => {
    expect(text.split("\n").filter((l) => l.includes('"WORKTREE_DIR"'))).toEqual(['  "WORKTREE_DIR": "/tmp/ralph-set-wt",']);
  });
  test("and one after the template's last setting, and one it never had, still parse", () => {
    expect(text).toContain('"LIVE_STEER": true,');
    expect(text).toContain('  "PR_MERGE_POLL": 5,\n}');
  });
  for (const what of ["unknown", "type", "method", "repo", "flag", "bare", "limits"]) {
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
    expect(both(refused.limits!)).toContain("RATE_LIMIT_RE and RATE_LIMIT_EXTRA_RE must make a regular expression as one pattern");
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
    // eslint-disable-next-line no-control-regex -- the escape that starts a colour
    const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
    const at = plain.indexOf(`${prefix} `);
    if (at < 0) return "";
    const word = plain.slice(at + prefix.length + 1).match(/^[^ \n]*/)?.[0] ?? "";
    return `${prefix} ${word}`;
  };
  /** The rest of the line after the prose in front of the command. */
  const after = (output: string, prose: string): string => {
    // eslint-disable-next-line no-control-regex -- the escape that starts a colour
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

describe("every command the harness prints reads back as the argv it names", () => {
  // Every hint the CLI and the loop print, collected in one place, for a loop
  // name holding what a shell reads as syntax and git still takes in a branch,
  // in a repo whose path holds a space. Each is handed to a shell the way a
  // paste would be, and what the shell passes on must be the argv the hint
  // names. zsh as well where it is installed: it is macOS's login shell, and it
  // reads a word starting with `=` as the path of a command (`=x` is
  // `command -v x`, or "x not found"), which bash does not. Windows refuses
  // `|` and `"` in a file name, and the loop name is a directory.
  const shells = ["bash", ...(Bun.which("zsh") ? ["zsh"] : [])];
  const names = [IS_WIN ? "n&b;c$e`f'g" : "n&b;c|d$e`f'g\"h", "=x"];
  const BRANCH = "rel&x'y";
  const found: { where: string; text: string; argv: string[] }[][] = [];

  /** On the first line holding `before`, the text after it, up to the last `upTo` or the end of the line. */
  const cut = (output: string, before: string, upTo?: string): string => {
    // eslint-disable-next-line no-control-regex -- the escape that starts a colour
    for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
      const at = line.indexOf(before);
      if (at < 0) continue;
      const rest = line.slice(at + before.length);
      const end = upTo === undefined ? -1 : rest.lastIndexOf(upTo);
      return end < 0 ? rest : rest.slice(0, end);
    }
    return "";
  };
  /** The words `shell` passes on when `text` is pasted after a command. */
  const readBack = (shell: string, text: string): string[] =>
    fx
      .sh([shell, "-c", `printf '%s\\0' ${text}\nwait`])
      .out.split("\0")
      .slice(0, -1);

  setup(async () => {
    for (const [i, name] of names.entries()) {
      const hints: { where: string; text: string; argv: string[] }[] = [];
      found.push(hints);
      const add = (where: string, text: string, argv: string[]) => hints.push({ where, text, argv });
      const app = fx.p(`hints-${i}`, "my app");
      const home = fx.p(`home-hints-${i}`);
      mkdirSync(fx.p(`hints-${i}`));
      fx.makeRepo(app, fx.p(`remote-hints-${i}.git`));

      add("ralph new", cut(fx.cli(home, ["new", name, app]).out, "3. "), ["ralph", "start", name]);
      const push = fx.cli(home, ["new", `${name}-push`, app, "--set", "PUSH=true", "--set", `BRANCH=${BRANCH}`]).err;
      add("ralph new, refusing PUSH true", cut(push, " — add ", " to mean it"), ["--set", `PUSH_CONFIRM=${BRANCH}`]);
      add("ralph new, offering a pull request", cut(push, " to mean it, or ", " to land"), ["--set", "PUSH=pr"]);

      patchConfig(join(home, name), TAME);
      const started = fx.cli(home, ["start", name], { STUB_DIR: fx.stub(`stub-hints-${i}`, ["commit"]) }).out;
      const verbs = `ralph status${cut(started, "  ralph status")}`.split("   ");
      add("ralph start: status", verbs[0] ?? "", ["ralph", "status", name]);
      add("ralph start: tail", verbs[1] ?? "", ["ralph", "tail", name]);
      add("ralph start: stop", verbs[2] ?? "", ["ralph", "stop", name]);
      await waitStopped(home, name);

      const review = fx.cli(home, ["review", name]).out;
      add("ralph review: merge them", cut(review, "merge them: "), ["git", "-C", app, "merge", `ralph/${name}`]);
      add("ralph review: look closer", cut(review, "look closer: ", " show <sha>"), [
        "git",
        "-C",
        fx.p(`hints-${i}`, `my app-ralph-${name}`),
      ]);
      add("ralph review: every verdict", cut(review, "every verdict: "), ["ralph", "results", name]);

      // The same name, as a loop the bash harness wrote.
      const shHome = fx.p(`home-hints-sh-${i}`);
      const legacy = join(shHome, name);
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "config.sh"), `REPO=${sq(app)}\nMAX_ITER=1\n`);
      await fx.runLoop(legacy, fx.stub(`stub-hints-sh-${i}`, ["commit"]));
      add("the loop, on config.sh", cut(read(join(legacy, "ralph.log")), "convert them: "), ["ralph", "migrate", name]);
      add("ralph start, on config.sh", cut(fx.cli(shHome, ["start", name]).err, "convert them first: "), ["ralph", "migrate", name]);
      add("ralph status, on config.sh", cut(fx.cli(shHome, ["status"]).out, "convert them: ", ")"), ["ralph", "migrate", name]);
      add("ralph review, on config.sh", cut(fx.cli(shHome, ["review", name]).err, "convert them first: "), ["ralph", "migrate", name]);
      // A bash-era loop still running on it: its command line names ralph.sh
      // and ends with the loop directory.
      const busy = Bun.spawn(["bash", "-c", "while :; do sleep 0.2; done", join(fx.T, "ralph.sh"), legacy], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await waitProc(busy.pid, legacy);
      writeFileSync(join(legacy, "ralph.pid"), `${busy.pid}\n`);
      add("ralph migrate, refusing a running loop", cut(fx.cli(shHome, ["migrate", name]).err, "stop it first: "), ["ralph", "stop", name]);
      busy.kill("SIGKILL");
      await busy.exited;
      add("ralph migrate", cut(fx.cli(shHome, ["migrate", name]).out, "check it, then: "), ["ralph", "start", name]);
    }
  });

  test("every place that prints a command was reached", () => {
    for (const hints of found) {
      expect(hints.length).toBe(15);
      for (const h of hints) expect(`${h.where}: ${h.text}`).not.toBe(`${h.where}: `);
    }
  });
  for (const [i, name] of names.entries()) {
    for (const shell of shells) {
      test(`for a loop named ${name}, ${shell} reads every hint back as the argv it names`, () => {
        const want = found[i]!.map((h) => ({ where: h.where, argv: h.argv }));
        expect(found[i]!.map((h) => ({ where: h.where, argv: readBack(shell, h.text) }))).toEqual(want);
      });
    }
  }
});

describe("ralph start does not believe a loop that never finished starting", () => {
  // Bun on Linux now and then never finishes loading the loop: no line of its
  // own, no child, a PID that `ralph status` calls running. RALPH_TEST_BOOT_HANG
  // makes the first process hang where the real one does, before its first line.
  const home = fx.p("home-bootwatch");
  const app = fx.p("app-bootwatch");
  const slow = join(home, "slow");
  const quick = join(home, "quick");
  const hang = fx.p("boot-hang");
  let started = { code: -1, out: "", err: "" };
  let finished = false;
  let log = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-bootwatch.git"));
    const S = fx.stub("stub-bootwatch", ["nothing", "nothing"]);
    const quiet = { QUIET_SLEEP: 0, STEP_SLEEP: 0, ERROR_SLEEP: 0, MAX_ITER: 1, REVIEW: false, PUSH: false };
    fx.cli(home, ["new", "slow", app]);
    patchConfig(slow, quiet);
    writeFileSync(hang, "");
    started = fx.cli(home, ["start", "slow"], { STUB_DIR: S, RALPH_TEST_BOOT_HANG: hang, RALPH_TEST_BOOT_WAIT: "2" });
    finished = await until(() => read(join(slow, "ralph.log")).includes("ralph finished"), 30);
    log = read(join(slow, "ralph.log"));

    fx.cli(home, ["new", "quick", app]);
    patchConfig(quick, quiet);
    fx.cli(home, ["start", "quick"], { STUB_DIR: S, RALPH_TEST_BOOT_WAIT: "2" });
    await until(() => read(join(quick, "ralph.log")).includes("ralph finished"), 30);
  });

  test("the start still succeeds", () => {
    expect(started.code).toBe(0);
    expect(started.out).toContain("started slow as PID");
  });
  test("ralph.log says the first process never started and was replaced", () => {
    expect(log).toContain("had not started after 2s (bun never finished loading it); killed it and started it again");
  });
  test("the process that hung is gone", () => {
    const pid = Number(/the loop process (\d+) had not started/.exec(log)?.[1] ?? 0);
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
  });
  test("the one started in its place ran the loop", () => {
    expect(finished).toBe(true);
    expect(log).toContain("=== iteration 1");
  });
  test("a loop that starts at once is started once, and ralph.log says nothing about it", () => {
    const q = read(join(quick, "ralph.log"));
    expect(q).toContain("=== iteration 1");
    expect(q).not.toContain("had not started");
  });
});

/**
 * A loop `ralph stop` did not stop, stopped as the handler would: TERM first, so
 * the agent's process group goes with it, and KILL only if TERM was not heard.
 */
async function stopFor(dir: string, pid: number): Promise<void> {
  if (!pid || !alive(pid)) return;
  term(dir, null, pid);
  if (!(await until(() => !alive(pid), 20))) process.kill(pid, "SIGKILL");
}

describe("ralph start says so when the loop did not start", () => {
  // The loop refuses a setting it cannot read by exiting before it runs. `ralph
  // start` printed "started <name> as PID n" in green and exited 0 for every
  // refusal there is, and the loop was gone before the human read the line.
  const home = fx.p("home-refused");
  const app = fx.p("app-refused");
  const cases: { name: string; spoil: (dir: string) => void; why: string }[] = [
    { name: "unknown", spoil: (d) => patchConfig(d, { NOPE_KEY: 1 }), why: "NOPE_KEY is not a setting this harness knows" },
    // These two crashed the loop before its log existed, and it read as started.
    { name: "proto", spoil: (d) => patchConfig(d, { toString: 1 }), why: "toString is not a setting this harness knows" },
    {
      name: "limits",
      spoil: (d) => patchConfig(d, { RATE_LIMIT_RE: "(?<x>limit)", RATE_LIMIT_EXTRA_RE: "\\k<y>" }),
      why: "must make a regular expression as one pattern",
    },
    // The frozen-file check read git's stdout alone, so a FROZEN that git
    // refuses, or that names nothing in the worktree, kept every commit.
    {
      name: "frozen",
      spoil: (d) => patchConfig(d, { WORKTREE: true, FROZEN: ["measure.sh", ""] }),
      why: "the frozen-file check cannot run",
    },
    {
      name: "absolute",
      spoil: (d) => patchConfig(d, { WORKTREE: true, FROZEN: [join(app, "measure.sh")] }),
      why: "FROZEN holds the absolute path",
    },
    { name: "badjson", spoil: (d) => writeFileSync(join(d, "config.json"), "{not json\n"), why: "does not parse" },
    { name: "noprompt", spoil: (d) => rmSync(join(d, "PROMPT.md")), why: "loop is missing PROMPT.md" },
    { name: "nogit", spoil: (d) => patchConfig(d, { REPO: fx.p("not-a-repo") }), why: "REPO is not a git checkout" },
    { name: "push", spoil: (d) => patchConfig(d, { WORKTREE: true, PUSH: true }), why: '"PUSH_CONFIRM": "main"' },
    { name: "hours", spoil: (d) => patchConfig(d, { ACTIVE_HOURS: "25-99" }), why: "ACTIVE_HOURS=25-99" },
    // These four refuse after the lock, while the loop sets up its worktree.
    // `ralph start` stopped waiting at the lock, so each printed "started" and
    // exited 0, and the loop was gone 130ms later.
    { name: "nobranch", spoil: (d) => patchConfig(d, { WORKTREE: true, BRANCH: "trunk" }), why: "cannot create worktree" },
    {
      name: "setupfail",
      spoil: (d) => patchConfig(d, { WORKTREE: true, SETUP_CMD: "exit 3" }),
      why: "SETUP_CMD failed; removed the new worktree",
    },
    {
      name: "foreign",
      spoil: (d) => {
        fx.makeRepo(fx.p("other-refused"), fx.p("remote-other-refused.git"));
        patchConfig(d, { WORKTREE: true, WORKTREE_DIR: fx.p("other-refused") });
      },
      why: "refusing to reset a checkout this loop does not own",
    },
    {
      name: "fulldir",
      spoil: (d) => {
        mkdirSync(fx.p("full-refused"));
        writeFileSync(fx.p("full-refused", "notes.txt"), "mine\n");
        patchConfig(d, { WORKTREE: true, WORKTREE_DIR: fx.p("full-refused") });
      },
      why: "cannot create worktree",
    },
  ];
  const ran: Record<string, { code: number; out: string; err: string; pidLeft: boolean; agent: boolean }> = {};
  let ok = { code: -1, out: "", err: "" };
  let okFinished = false;

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-refused.git"));
    mkdirSync(fx.p("not-a-repo"));
    for (const c of cases) {
      const S = fx.stub(`stub-refused-${c.name}`, ["commit"]);
      fx.cli(home, ["new", c.name, app]);
      patchConfig(join(home, c.name), TAME);
      c.spoil(join(home, c.name));
      const r = fx.cli(home, ["start", c.name], { STUB_DIR: S });
      // The refusal is the loop's first second; one that started anyway runs an
      // iteration, which is time enough to see it.
      await Bun.sleep(300);
      ran[c.name] = { ...r, pidLeft: existsSync(join(home, c.name, "ralph.pid")), agent: existsSync(join(S, "agent_calls")) };
    }
    const S = fx.stub("stub-refused-ok", ["nothing"]);
    fx.cli(home, ["new", "fine", app]);
    patchConfig(join(home, "fine"), TAME);
    ok = fx.cli(home, ["start", "fine"], { STUB_DIR: S });
    okFinished = await until(() => read(join(home, "fine", "ralph.log")).includes("ralph finished"), 30);
  });

  for (const c of cases) {
    test(`${c.name}: the start fails, and says why in the loop's words`, () => {
      const r = ran[c.name]!;
      expect(r.out).not.toContain("started");
      expect(r.err).toContain(`${c.name} did not start`);
      expect(r.err).toContain(c.why);
      expect(r.code).not.toBe(0);
    });
    test(`${c.name}: no agent ran, and no ralph.pid is left naming the process that refused`, () => {
      expect(ran[c.name]!.agent).toBe(false);
      expect(ran[c.name]!.pidLeft).toBe(false);
    });
  }
  test("a loop that starts still says started, and exits 0", () => {
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("started fine as PID");
    expect(ok.out).not.toContain("still starting");
    expect(ok.err).toBe("");
    expect(okFinished).toBe(true);
  });
});

describe("ralph start does not wait out a long SETUP_CMD", () => {
  // `ralph start` waits for the loop's whole start, the worktree's SETUP_CMD
  // included, but only BOOT_WAIT seconds past the lock: an `npm ci` can take
  // minutes, and the loop is not refusing anything while it runs.
  const home = fx.p("home-setupslow");
  const app = fx.p("app-setupslow");
  const loop = join(home, "slowsetup");
  let r = { code: -1, out: "", err: "" };
  let secs = 0;
  let startedThen = true;
  let finished = false;
  let S = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-setupslow.git"));
    S = fx.stub("stub-setupslow", ["nothing"]);
    fx.cli(home, ["new", "slowsetup", app]);
    patchConfig(loop, { ...TAME, WORKTREE: true, SETUP_CMD: "sleep 8" });
    const t0 = Date.now();
    r = fx.cli(home, ["start", "slowsetup"], { STUB_DIR: S, RALPH_TEST_BOOT_WAIT: "2" });
    secs = (Date.now() - t0) / 1000;
    startedThen = existsSync(join(loop, ".started"));
    finished = await until(() => read(join(loop, "ralph.log")).includes("ralph finished"), 60);
  });

  test("it says started, and that the loop is still starting, before the setup is done", () => {
    expect(r.code).toBe(0);
    expect(r.out).toContain("started slowsetup as PID");
    expect(r.out).toContain("still starting after 2s");
    expect(startedThen).toBe(false);
    expect(secs).toBeLessThan(8);
  });
  test("and the loop goes on to run once its setup is done", () => {
    expect(finished).toBe(true);
    expect(read(join(S, "agent_calls")).trim()).toBe("1");
  });
});

describe("a running loop whose ralph.pid names somebody else is still the running loop", () => {
  // Two `ralph start` at once both pass the "already running" check, both spawn
  // a loop and both write ralph.pid; the lock lets one run. Measured five times:
  // both printed "started", and once ralph.pid named the one the lock refused,
  // so `ralph status` said stopped and `ralph stop` "not running" about a loop
  // that ran on. The loop's own ralph.lock names it all along.
  const home = fx.p("home-lostpid");
  const app = fx.p("app-lostpid");
  const loop = join(home, "lost");
  let S = "";
  let lock = 0;
  let status = "";
  let again = { code: -1, out: "", err: "" };
  let stop = { code: -1, out: "", err: "" };
  let loopGone = false;
  let agentGone = false;

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-lostpid.git"));
    S = fx.stub("stub-lostpid", ["sleep"]);
    fx.cli(home, ["new", "lost", app]);
    patchConfig(loop, { ...TAME, ITER_TIMEOUT: 600 });
    fx.cli(home, ["start", "lost"], { STUB_DIR: S });
    try {
      await until(() => read(join(S, "sleeper.pid")).trim() !== "", 20);
      lock = Number(read(join(loop, "ralph.lock")).trim());
      // A PID that was a process a moment ago and is not one now.
      const gone = Bun.spawn(["true"]);
      await gone.exited;
      writeFileSync(join(loop, "ralph.pid"), `${gone.pid}\n`);
      status = fx.cli(home, ["status", "lost"]).out;
      again = fx.cli(home, ["start", "lost"], { STUB_DIR: S });
      stop = fx.cli(home, ["stop", "lost"]);
      loopGone = await until(() => !alive(lock), 20);
      agentGone = sleeperGone(join(S, "sleeper.pid"));
    } finally {
      await stopFor(loop, lock);
    }
  });

  test("ralph status calls it running, under the PID that holds the lock", () => {
    expect(lock).toBeGreaterThan(0);
    expect(status).toContain("running");
    expect(status).toContain(`PID ${lock}`);
  });
  test("ralph start refuses it as already running, and starts nothing", () => {
    expect(again.out).not.toContain("started");
    expect(again.err).toContain(`already running as PID ${lock}`);
    expect(again.code).not.toBe(0);
    expect(read(join(S, "agent_calls")).trim()).toBe("1");
  });
  test("ralph stop stops it, and the agent with it", () => {
    expect(stop.code).toBe(0);
    expect(stop.out).toContain(`stopped lost (PID ${lock})`);
    expect(loopGone).toBe(true);
    expect(agentGone).toBe(true);
  });
});

describe("two ralph start at once: one loop runs, and one start says so", () => {
  const home = fx.p("home-twice");
  const app = fx.p("app-twice");
  const loop = join(home, "twice");
  let S = "";
  let starts: { code: number; out: string; err: string }[] = [];
  let lock = 0;
  let status = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-twice.git"));
    S = fx.stub("stub-twice", ["sleep", "sleep"]);
    fx.cli(home, ["new", "twice", app]);
    patchConfig(loop, { ...TAME, ITER_TIMEOUT: 600 });
    const argv = IS_WIN ? [process.execPath, cliPath(), "start", "twice"] : [cliPath(), "start", "twice"];
    const one = () => {
      const p = Bun.spawn(argv, { env: fx.env({ RALPH_HOME: home, STUB_DIR: S }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      return (async () => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() }))();
    };
    try {
      starts = await Promise.all([one(), one()]);
      await until(() => read(join(S, "sleeper.pid")).trim() !== "", 20);
      lock = Number(read(join(loop, "ralph.lock")).trim());
      status = fx.cli(home, ["status", "twice"]).out;
    } finally {
      fx.cli(home, ["stop", "twice"]);
      await stopFor(loop, lock);
    }
  });

  test("exactly one says started, under the PID that holds the lock", () => {
    const started = starts.filter((s) => s.out.includes("started twice as PID"));
    expect(started.length).toBe(1);
    expect(started[0]!.code).toBe(0);
    expect(started[0]!.out).toContain(`as PID ${lock}`);
  });
  test("the other fails, saying it is already running", () => {
    const other = starts.find((s) => !s.out.includes("started"));
    expect(other?.err).toContain(`already running as PID ${lock}`);
    expect(other?.code).not.toBe(0);
  });
  test("ralph status shows the loop that runs", () => {
    expect(status).toContain(`PID ${lock}`);
  });
});
