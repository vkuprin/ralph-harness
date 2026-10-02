import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import {
  cliPath,
  count,
  Fx,
  IS_WIN,
  join,
  loopArgv,
  patchConfig,
  read,
  readConfigValue,
  ROOT,
  setup,
  sq,
  statuses,
  TEMPLATE_CONFIG,
  writeConfig,
} from "../helpers/index.ts";

const fx = new Fx("config");
const T = fx.T;

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
/** What `wc -l` says: the number of newlines. */
const newlines = (text: string) => text.split("\n").length - 1;

describe("bad configuration and odd inputs", () => {
  const setupRuns = fx.p("setup-runs");
  const g = fx.p("loops/g");
  const h = fx.p("loops/h");
  const h2 = fx.p("loops/h2");
  const i = fx.p("loops/i");
  const j = fx.p("loops/j");
  const k = fx.p("loops/k");
  const l = fx.p("loops/l");
  const n = fx.p("loops/n");
  const elsewhere = fx.p("elsewhere");
  let Sk = "";

  setup(async () => {
    // A SETUP_CMD that fails. The half-built worktree goes, and the branch it was
    // built on goes with it: keeping the branch made the next start skip SETUP_CMD.
    fx.makeRepo(fx.p("app-g"), fx.p("remote-g.git"));
    const Sg = fx.stub("stub-g", ["commit", "commit"]);
    fx.makeLoop(g, fx.p("app-g"), { WORKTREE: true, MAX_ITER: 2, SETUP_CMD: `echo preparing >> ${sq(setupRuns)}; exit 3` });
    await fx.runLoop(g, Sg);
    await fx.runLoop(g, Sg);

    // WORKTREE_DIR pointing somewhere that is not a worktree of REPO. The harness
    // hard-resets and cleans whatever it finds there after every iteration.
    fx.makeRepo(fx.p("app-h"), fx.p("remote-h.git"));
    fx.fresh(elsewhere);
    fx.sh(["git", "init", "-q", "-b", "main", elsewhere]);
    writeFileSync(join(elsewhere, "precious.txt"), "keep\n");
    fx.gitOk(elsewhere, "add", "-A");
    fx.gitOk(elsewhere, "commit", "-qm", "not ralph's work");
    writeFileSync(join(elsewhere, "untracked.txt"), "scratch\n");
    const Sh = fx.stub("stub-h", ["commit"]);
    fx.makeLoop(h, fx.p("app-h"), { WORKTREE: true, MAX_ITER: 1, WORKTREE_DIR: elsewhere });
    await fx.runLoop(h, Sh);

    const notempty = fx.p("notempty");
    fx.fresh(notempty);
    mkdirSync(notempty);
    writeFileSync(join(notempty, "x"), "x\n");
    fx.makeLoop(h2, fx.p("app-h"), { WORKTREE: true, MAX_ITER: 1, WORKTREE_DIR: notempty });
    await fx.runLoop(h2, Sh);

    // PUSH=1 in a repository with no origin: say it once and carry on as PUSH=0.
    const appI = fx.p("app-i");
    fx.fresh(appI);
    fx.sh(["git", "init", "-q", "-b", "main", appI]);
    writeFileSync(join(appI, "measure.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(appI, "measure.sh"), 0o755);
    fx.gitOk(appI, "add", "-A");
    fx.gitOk(appI, "commit", "-qm", "initial");
    const Si = fx.stub("stub-i", ["commit", "commit"]);
    fx.makeLoop(i, appI, { WORKTREE: true, PUSH: true, PUSH_CONFIRM: "main", MAX_ITER: 2 });
    await fx.runLoop(i, Si);

    // ralph/<name> deleted while the loop runs: the loop puts the branch back.
    fx.makeRepo(fx.p("app-j"), fx.p("remote-j.git"));
    const Sj = fx.stub("stub-j", ["drop-branch", "commit"]);
    fx.makeLoop(j, fx.p("app-j"), { WORKTREE: true, MAX_ITER: 2 });
    await fx.runLoop(j, Sj);

    // A PROMPT.md with no "## The job" heading.
    fx.makeRepo(fx.p("app-k"), fx.p("remote-k.git"));
    Sk = fx.stub("stub-k", ["commit"]);
    fx.makeLoop(k, fx.p("app-k"), { WORKTREE: true, REVIEW: true, MAX_ITER: 1 });
    writeFileSync(join(k, "PROMPT.md"), "Find and fix the races in the scheduler.\n");
    await fx.runLoop(k, Sk);

    // MAX_ITER=0: a ceiling of none. Stop before the first iteration.
    fx.makeRepo(fx.p("app-l"), fx.p("remote-l.git"));
    const Sl = fx.stub("stub-l", ["commit"]);
    fx.makeLoop(l, fx.p("app-l"), { WORKTREE: true, MAX_ITER: 0 });
    await fx.runLoop(l, Sl);

    // A repo path with a space in it, through every gate there is.
    fx.makeRepo(fx.p("my app"), fx.p("remote-n.git"));
    const Sn = fx.stub("stub-n", ["commit", "nothing"]);
    fx.makeLoop(n, fx.p("my app"), {
      WORKTREE: true,
      PUSH: true,
      PUSH_CONFIRM: "main",
      REVIEW: true,
      MAX_ITER: 2,
      VERIFY_CMD: "./measure.sh",
    });
    await fx.runLoop(n, Sn, { remote: fx.p("remote-n.git") });
  });

  test("a failed SETUP_CMD leaves no worktree behind", () => {
    expect(existsSync(fx.p("app-g-ralph-g"))).toBe(false);
  });
  test("the next start runs SETUP_CMD again instead of skipping it", () => {
    expect(newlines(read(setupRuns))).toBe(2);
  });
  test("a loop whose setup failed runs no iteration", () => {
    expect(existsSync(join(g, "results.tsv"))).toBe(false);
  });
  test("a WORKTREE_DIR holding someone else's checkout is refused", () => {
    expect(read(join(h, "ralph.log"))).toContain("not a worktree of");
  });
  test("nothing was committed into that checkout", () => {
    expect(fx.git(elsewhere, "rev-list", "--count", "HEAD")).toBe("1");
  });
  test("and its uncommitted file was not cleaned away", () => {
    expect(existsSync(join(elsewhere, "untracked.txt"))).toBe(true);
  });
  test("a WORKTREE_DIR that exists and holds no checkout stops the loop", () => {
    expect(read(join(h2, "ralph.log"))).toContain("cannot create worktree");
  });
  test("with no origin the loop still runs and keeps its commits", () => {
    expect(statuses(i)).toBe("keep keep");
  });
  test("the missing origin is logged once, not once per sync", () => {
    expect(count(read(join(i, "ralph.log")), /no origin remote/)).toBe(1);
  });
  test("and no failed fetch is logged at all", () => {
    expect(read(join(i, "ralph.log"))).not.toContain("fetch failed");
  });
  test("a branch deleted under the loop is put back, and the loop goes on", () => {
    expect(statuses(j)).toBe("revert:history keep");
  });
  test("so it never stops asking for a human", () => {
    expect(read(join(j, "ralph.log"))).not.toContain("fix the worktree by hand");
  });
  test("the restored branch and the worktree agree", () => {
    const branch = fx.git(fx.p("app-j"), "rev-parse", "ralph/j");
    expect(branch).not.toBe("");
    expect(branch).toBe(fx.git(fx.p("app-j-ralph-j"), "rev-parse", "HEAD"));
  });
  test("with no '## The job' heading the reviewer still gets the job", () => {
    expect(read(join(Sk, "prompt.review.1"))).toContain("races in the scheduler");
  });
  test("MAX_ITER=0 runs no iteration", () => {
    expect(read(join(l, "ralph.log"))).toContain("finished after 0 iterations");
  });
  test("and records no verdict", () => {
    expect(existsSync(join(l, "results.tsv"))).toBe(false);
  });
  test("a repo path with a space survives verify, review and push", () => {
    expect(statuses(n)).toBe("keep quiet");
  });
  test("its worktree was made next to it", () => {
    expect(isDir(fx.p("my app-ralph-n"))).toBe(true);
  });
  test("and its commit reached origin", () => {
    expect(fx.git(fx.p("remote-n.git"), "log", "--format=%s", "main")).toContain("stub: work");
  });
});

describe("a loop that cannot start says why where the reader is sent", () => {
  // Everything the loop said before its first iteration went to stderr alone,
  // and `ralph start` points stderr at ralph.out: nothing anywhere told the
  // reader why a loop was gone a second after it started.
  const home = fx.p("home-boot");
  const appBoot = fx.p("app-boot");
  const B1 = join(home, "boot1");
  const B2 = join(home, "boot2");
  const B3 = join(home, "boot3");
  const B4 = join(home, "boot4");
  const B5 = join(home, "boot5");
  let boot1 = { code: -1, out: "", err: "" };
  let boot1Log = "";
  let boot1Status = "";
  let boot4Code = -1;
  let bootHead = "";

  /** A loop directory under home with the template's PROMPT.md and PROGRESS.md. */
  function bootLoop(d: string): void {
    fx.fresh(d);
    mkdirSync(d, { recursive: true });
    copyFileSync(join(ROOT, "template/PROMPT.md"), join(d, "PROMPT.md"));
    copyFileSync(join(ROOT, "template/PROGRESS.md"), join(d, "PROGRESS.md"));
  }

  setup(async () => {
    fx.makeRepo(appBoot, fx.p("remote-boot.git"));
    const S = fx.stub("stub-boot");
    mkdirSync(home, { recursive: true });
    const env = { RALPH_HOME: home };

    bootLoop(B1);
    writeConfig(B1, { MAX_ITER: 1 }); // no REPO
    boot1 = fx.sh(loopArgv(B1), { env });
    boot1Log = fx.cli(home, ["log", "boot1"]).out;
    // With no REPO the work directory is empty, and `git -C ""` leaves the
    // working directory alone — so status reported whatever repository the
    // reader was standing in as this loop's HEAD.
    boot1Status = fx.sh([cliPath(), "status", "boot1"], { cwd: ROOT, env }).out;

    bootLoop(B2);
    writeConfig(B2, { REPO: fx.p("not-a-repo") });
    fx.sh(loopArgv(B2), { env });

    fx.fresh(B3);
    mkdirSync(B3, { recursive: true });
    copyFileSync(join(ROOT, "template/PROMPT.md"), join(B3, "PROMPT.md"));
    writeConfig(B3, { REPO: appBoot });
    fx.sh(loopArgv(B3), { env });

    // A config that does not parse was once read up to the error and run on:
    // that left WORKTREE off, so a loop written for a gated worktree committed
    // straight into the user's own checkout.
    bootLoop(B4);
    writeFileSync(
      join(B4, "config.json"),
      `{ "REPO": ${JSON.stringify(appBoot)},\n  "QUIET_SLEEP": 0, "STEP_SLEEP": 0, "MAX_ITER": 1,\n  if [ 1 ; then\n  "WORKTREE": true\n}\n`,
    );
    writeFileSync(join(S, "modes"), "commit\n");
    bootHead = fx.git(appBoot, "rev-parse", "HEAD");
    boot4Code = fx.sh(loopArgv(B4), { env: { ...env, STUB_DIR: S } }).code;

    // The guard: a healthy config starts, and says nothing about itself.
    bootLoop(B5);
    writeConfig(B5, { REPO: appBoot, QUIET_SLEEP: 0, STEP_SLEEP: 0, MAX_ITER: 1, WORKTREE: true });
    writeFileSync(join(S, "modes"), "nothing\n");
    await fx.runLoop(B5, S, { env });
  });

  test("a loop with no REPO still exits 2", () => {
    expect(boot1.code).toBe(2);
  });
  test("the reason still reaches a terminal, so the log is not a hiding place", () => {
    expect(boot1.out + boot1.err).toContain("must set REPO");
  });
  test("the reason reaches ralph.log", () => {
    expect(read(join(B1, "ralph.log"))).toContain("must set REPO");
  });
  test("ralph log shows it", () => {
    expect(boot1Log).toContain("must set REPO");
  });
  test("status does not credit it with the HEAD of wherever you are standing", () => {
    expect(boot1Status).not.toContain("HEAD  ");
  });
  test("a REPO that is not a checkout says so in the log", () => {
    expect(read(join(B2, "ralph.log"))).toContain("not a git checkout");
  });
  test("a loop missing PROGRESS.md says so in the log", () => {
    expect(read(join(B3, "ralph.log"))).toContain("missing PROGRESS.md");
  });
  test("a config.json that does not parse stops the loop", () => {
    expect(boot4Code).toBe(2);
  });
  test("the log names the file", () => {
    expect(read(join(B4, "ralph.log"))).toContain("config.json");
  });
  test("the parser's own reason is in the log too", () => {
    expect(read(join(B4, "ralph.log"))).toMatch(/does not parse: \S/);
  });
  test("no iteration ran with half the settings applied", () => {
    expect(read(join(B4, "ralph.log"))).not.toContain("=== iteration");
  });
  test("the repository it would have committed into is untouched", () => {
    expect(fx.git(appBoot, "rev-parse", "HEAD")).toBe(bootHead);
  });
  test("a healthy config starts", () => {
    expect(read(join(B5, "ralph.log"))).toContain("=== iteration 1");
  });
  test("a healthy start says nothing about config.json", () => {
    expect(read(join(B5, "ralph.log"))).not.toContain("config.json");
  });
});

describe("ralph new writes a repo path the loop reads back exactly", () => {
  // `ralph new` writes the repo path into the config, and the harness reads it
  // back. When that config was bash and was sourced, a $ expanded, a backtick
  // ran and a " ended the string: a path a directory may legally hold arrived
  // at the loop as something else, after `ralph new` had said "created". JSON
  // has none of that, and these keep it so.
  const home = fx.p("home-src");
  const cfg = (name: string) => join(home, name, "config.json");
  /** REPO as the harness actually receives it. */
  const repoOf = (name: string) => readConfigValue(cfg(name), "REPO");

  const srcDollar = join(T, "pre$HOME-src");
  const ran = fx.p("SOURCED-RAN");
  const srcTick = `${T}/q\`touch ${ran}\`-src`;
  const srcSub = join(T, "s$(echo no)-src");
  const srcQuote = `${T}/d"q-src`;
  const appSrc = fx.p("app-src");
  let tickRan = true;
  let tickRepo: string | undefined;

  setup(async () => {
    const S = fx.stub("stub-src", ["commit"]);
    const env = { RALPH_HOME: home };

    // A $ is silent when the variable happens to be set: no error anywhere, and
    // the loop then dies about a path the user never typed.
    fx.makeRepo(srcDollar, fx.p("remote-src1.git"));
    fx.cli(home, ["new", "dollar", srcDollar]);

    // The loud one: a backtick is command substitution, so merely reading the
    // settings of such a loop runs a command out of a directory name. On
    // Windows no directory can be named after a command with a path in it.
    if (!IS_WIN) {
      fx.makeRepo(srcTick, fx.p("remote-src2.git"));
      fx.cli(home, ["new", "tick", srcTick]);
      rmSync(ran, { force: true });
      tickRepo = repoOf("tick");
      tickRan = existsSync(ran);
    }

    // $(...) is the same substitution spelled differently, and a " ends the
    // string early — which swallows the settings after it rather than failing.
    fx.makeRepo(srcSub, fx.p("remote-src3.git"));
    fx.cli(home, ["new", "sub", srcSub]);
    // Windows allows no " in a file name.
    if (!IS_WIN) {
      fx.makeRepo(srcQuote, fx.p("remote-src4.git"));
      fx.cli(home, ["new", "quote", srcQuote]);
    }

    // The strongest check: the scaffold is not merely written, it works.
    patchConfig(join(home, "dollar"), {
      QUIET_SLEEP: 0,
      STEP_SLEEP: 0,
      ERROR_SLEEP: 0,
      PUSH: false,
      REVIEW: false,
      MAX_ITER: 1,
    });
    await fx.runLoop(join(home, "dollar"), S, { env });

    // Guards: an ordinary path still round-trips, the file still holds every
    // line of the template, and no placeholder of any name is left.
    fx.makeRepo(appSrc, fx.p("remote-src5.git"));
    fx.cli(home, ["new", "plainsrc", appSrc]);
  });

  test("a $ in the repo path is not expanded", () => {
    expect(repoOf("dollar")).toBe(srcDollar);
  });
  test.skipIf(IS_WIN)("a backtick in the repo path stays text and is not run", () => {
    expect(tickRan).toBe(false);
  });
  test.skipIf(IS_WIN)("and that path too arrives whole", () => {
    expect(tickRepo).toBe(srcTick);
  });
  test("a $(...) in the repo path is not run", () => {
    expect(repoOf("sub")).toBe(srcSub);
  });
  test.skipIf(IS_WIN)('a " in the repo path does not end the string early', () => {
    expect(repoOf("quote")).toBe(srcQuote);
  });
  test.skipIf(IS_WIN)("so the settings after REPO are still read", () => {
    expect(readConfigValue(cfg("quote"), "MAX_ITER") ?? "").not.toBe("");
  });
  test("and the loop scaffolded on such a path runs and keeps its commit", () => {
    expect(statuses(join(home, "dollar"))).toBe("keep");
  });
  test("an ordinary path still reads back exactly", () => {
    expect(repoOf("plainsrc")).toBe(appSrc);
  });
  test("an ordinary path is written as a plain JSON string", () => {
    const want = `  "REPO": ${JSON.stringify(appSrc)},`;
    expect(read(cfg("plainsrc")).split("\n")).toContain(want);
  });
  test("and the file still holds every line of the template", () => {
    expect(newlines(read(cfg("plainsrc")))).toBe(newlines(readFileSync(TEMPLATE_CONFIG, "utf8")));
  });
  test("with no placeholder of any name left behind", () => {
    expect(read(cfg("plainsrc"))).not.toMatch(/__[A-Z_]*__/);
    expect(read(join(home, "plainsrc", "PROMPT.md"))).not.toMatch(/__[A-Z_]*__/);
  });
  test("the SETUP_CMD hint still shows the path as the reader would type it", () => {
    expect(read(cfg("plainsrc"))).toContain(`cp ${appSrc}/.env .`);
  });
});

describe("PUSH true lands only on a branch the config names twice", () => {
  // An old loop with PUSH true, restarted, pushed its kept commits straight to
  // main, and on a repository whose main deploys that is production.
  const home = fx.p("home-confirm");
  const app = fx.p("app-confirm");
  const R = fx.p("remote-confirm.git");
  const bare = join(home, "bare");
  const other = join(home, "other");
  const pr = join(home, "viapr");
  const notes = fx.p("notify-confirm.log");
  let S = "";
  let start = "";
  let bareRc = -1;
  let otherRc = -1;
  let refusedNew = { code: -1, out: "", err: "" };
  let confirmedNew = { code: -1, out: "", err: "" };

  setup(async () => {
    fx.makeRepo(app, R);
    start = fx.git(R, "rev-parse", "main");
    S = fx.stub("stub-confirm", ["commit", "commit", "nothing"]);
    writeFileSync(fx.p("notify-confirm.sh"), `#!/bin/sh\necho "$RALPH_EVENT $RALPH_LOOP" >> ${sq(notes)}\n`);
    chmodSync(fx.p("notify-confirm.sh"), 0o755);
    const base = { WORKTREE: true, PUSH: true, MAX_ITER: 1, QUIET_SLEEP: 0, STEP_SLEEP: 0, NOTIFY_CMD: sq(fx.p("notify-confirm.sh")) };
    fx.makeLoop(bare, app, base);
    bareRc = await fx.runLoop(bare, S, { remote: R });
    fx.makeLoop(other, app, { ...base, PUSH_CONFIRM: "develop" });
    otherRc = await fx.runLoop(other, S, { remote: R });
    fx.makeLoop(pr, app, { WORKTREE: true, PUSH: "pr", MAX_ITER: 1 });
    await fx.runLoop(pr, S, { remote: R });

    refusedNew = fx.cli(home, ["new", "straight", app, "--set", "PUSH=true"]);
    confirmedNew = fx.cli(home, ["new", "confirmed", app, "--set", "PUSH=true", "--set", "PUSH_CONFIRM=main"]);
    fx.cli(home, ["new", "plain", app]);
  });

  test("without PUSH_CONFIRM the loop refuses to start", () => {
    expect(bareRc).toBe(2);
    const log = read(join(bare, "ralph.log"));
    expect(log).toContain("PUSH true pushes every kept commit straight to origin/main");
    expect(log).toContain('set "PUSH_CONFIRM": "main" in config.json');
    expect(log).not.toContain("=== iteration");
  });
  test("the human hears the refusal", () => {
    expect(read(notes)).toContain("refused bare");
  });
  test("a PUSH_CONFIRM naming another branch is no confirmation", () => {
    expect(otherRc).toBe(2);
    expect(read(join(other, "ralph.log"))).toContain('PUSH_CONFIRM names "develop", not BRANCH "main"');
  });
  test("nothing reached main, and no worktree was made", () => {
    expect(fx.git(R, "rev-parse", "main")).toBe(start);
    expect(existsSync(fx.p("app-confirm-ralph-bare"))).toBe(false);
  });
  test('PUSH "pr" needs no confirmation', () => {
    expect(read(join(pr, "ralph.log"))).toContain("=== iteration 1");
  });
  test("ralph new will not scaffold PUSH true without it, and leaves nothing behind", () => {
    expect(refusedNew.code).not.toBe(0);
    expect(refusedNew.err).toContain("--set PUSH_CONFIRM=main");
    expect(existsSync(join(home, "straight"))).toBe(false);
  });
  test("with it, ralph new writes both", () => {
    expect(confirmedNew.code).toBe(0);
    expect(readConfigValue(join(home, "confirmed", "config.json"), "PUSH")).toBe("true");
    expect(readConfigValue(join(home, "confirmed", "config.json"), "PUSH_CONFIRM")).toBe("main");
  });
  test("a new loop lands through a draft pull request unless told otherwise", () => {
    expect(readConfigValue(join(home, "plain", "config.json"), "PUSH")).toBe("pr");
    expect(readConfigValue(join(home, "plain", "config.json"), "PR_DRAFT")).toBe("true");
  });
});

describe("a timeout of 0 or less is the default, not a kill on the spot", () => {
  // 0 turns off QUIET_STOP, ERROR_STOP, CHURN_AT and PROGRESS_MAX_BYTES, so a
  // reader takes ITER_TIMEOUT 0 for "no timeout". It killed every agent before
  // it had run, and VERIFY_TIMEOUT 0 reverted every commit the agent was paid
  // for as "verify timed out after 0s", iteration after iteration.
  const it0 = fx.p("loops/it0");
  const vt0 = fx.p("loops/vt0");
  let Si = "";
  let Sv = "";

  setup(async () => {
    fx.makeRepo(fx.p("app-it0"), fx.p("remote-it0.git"));
    Si = fx.stub("stub-it0", ["commit"], ["ACCEPT"]);
    fx.makeLoop(it0, fx.p("app-it0"), { WORKTREE: true, REVIEW: true, MAX_ITER: 1, ITER_TIMEOUT: 0 });
    await fx.runLoop(it0, Si);

    fx.makeRepo(fx.p("app-vt0"), fx.p("remote-vt0.git"));
    Sv = fx.stub("stub-vt0", ["commit"]);
    fx.makeLoop(vt0, fx.p("app-vt0"), { WORKTREE: true, MAX_ITER: 1, VERIFY_TIMEOUT: -1, VERIFY_CMD: "./measure.sh" });
    await fx.runLoop(vt0, Sv);
  });

  test("ITER_TIMEOUT 0 lets the agent run and its commit is kept", () => {
    expect(statuses(it0)).toBe("keep");
  });
  test("the agent and the reviewer each ran once", () => {
    expect(read(join(Si, "agent_calls")).trim()).toBe("1");
    expect(read(join(Si, "review_calls")).trim()).toBe("1");
  });
  test("the log says which timeout it runs with instead", () => {
    expect(read(join(it0, "ralph.log"))).toContain("ITER_TIMEOUT 0 is not a timeout; using the default 7200s");
  });
  test("a VERIFY_TIMEOUT below 0 lets VERIFY_CMD run, and the commit is kept", () => {
    expect(statuses(vt0)).toBe("keep");
  });
  test("and the agent is told the timeout VERIFY_CMD really has", () => {
    expect(read(join(Sv, "prompt.agent.1"))).toContain("for up to 1800s");
    expect(read(join(vt0, "ralph.log"))).toContain("VERIFY_TIMEOUT -1 is not a timeout; using the default 1800s");
  });
});

describe.skipIf(IS_WIN)("a backslash in REPO does not make any checkout this loop's own", () => {
  // The harness resets and cleans WORKTREE_DIR after every iteration, so it
  // checks first that the checkout there belongs to REPO, by the repository
  // each one's git lives in. Bun's realpath cannot open a path holding a
  // backslash on macOS and Linux; both sides came back unknown, unknown
  // matched unknown, and a stranger's checkout was taken as the loop's own.
  const bs = fx.p("loops/bs");
  const ok = fx.p("loops/bs-ok");
  const stranger = fx.p("else\\where");

  setup(async () => {
    fx.makeRepo(fx.p("app\\bs"), fx.p("remote-bs.git"));
    fx.fresh(stranger);
    fx.sh(["git", "init", "-q", "-b", "main", stranger]);
    writeFileSync(join(stranger, "precious.txt"), "keep\n");
    fx.gitOk(stranger, "add", "-A");
    fx.gitOk(stranger, "commit", "-qm", "not ralph's work");
    writeFileSync(join(stranger, "untracked.txt"), "scratch\n");
    const S = fx.stub("stub-bs", ["commit"]);
    fx.makeLoop(bs, fx.p("app\\bs"), { WORKTREE: true, MAX_ITER: 1, WORKTREE_DIR: stranger });
    await fx.runLoop(bs, S);

    // The same REPO with a worktree of its own still runs, at the start and
    // again after a restart, which finds the worktree already there.
    fx.makeRepo(fx.p("app\\ok"), fx.p("remote-bs-ok.git"));
    const So = fx.stub("stub-bs-ok", ["commit", "commit"]);
    fx.makeLoop(ok, fx.p("app\\ok"), { WORKTREE: true, MAX_ITER: 1 });
    await fx.runLoop(ok, So);
    await fx.runLoop(ok, So);
  });

  test("a stranger's checkout at WORKTREE_DIR is refused", () => {
    expect(read(join(bs, "ralph.log"))).toContain("not a worktree of");
    expect(existsSync(join(bs, "results.tsv"))).toBe(false);
  });
  test("its uncommitted file is still there", () => {
    expect(existsSync(join(stranger, "untracked.txt"))).toBe(true);
  });
  test("and nothing was committed into it", () => {
    expect(fx.git(stranger, "rev-list", "--count", "HEAD")).toBe("1");
  });
  test("REPO's own worktree is used, and found again after a restart", () => {
    expect(statuses(ok)).toBe("keep keep");
    expect(read(join(ok, "ralph.log"))).not.toContain("not a worktree of");
  });
});

describe("a WORKTREE_DIR that is a checkout of REPO but not this loop's worktree is refused", () => {
  // Belonging to REPO's repository was the whole check. REPO itself passed,
  // and so did a folder inside it and another loop's worktree; one iteration
  // then wiped the edit nobody had committed there, left the checkout on
  // ralph/<name>, and kept the agent's commit, never judged, on the branch
  // that had been out.
  const cases: { name: string; dir: string; loop: string }[] = [];
  /** The state a refusal must leave alone: what is out, and the unsaved work. */
  const snap = (dir: string) => ({
    head: fx.git(dir, "rev-parse", "HEAD"),
    ref: fx.git(dir, "symbolic-ref", "-q", "HEAD"),
    edit: read(join(dir, "work.txt")),
    untracked: existsSync(join(dir, "notes.txt")),
    count: fx.git(dir, "rev-list", "--count", "--all"),
  });
  const before = new Map<string, ReturnType<typeof snap>>();
  const own = fx.p("loops/wd-own");

  /** Unsaved work in `dir`, the loop run once with WORKTREE_DIR at it. */
  async function point(name: string, repo: string, dir: string): Promise<void> {
    writeFileSync(join(dir, "work.txt"), "an edit nobody committed\n");
    writeFileSync(join(dir, "notes.txt"), "untracked notes\n");
    const loop = fx.p(`loops/${name}`);
    fx.makeLoop(loop, repo, { WORKTREE: true, MAX_ITER: 1, WORKTREE_DIR: dir });
    before.set(name, snap(dir));
    cases.push({ name, dir, loop });
    await fx.runLoop(loop, fx.stub(`stub-${name}`, ["commit"]));
  }

  setup(async () => {
    // REPO itself.
    fx.makeRepo(fx.p("app-wd-repo"), fx.p("remote-wd-repo.git"));
    await point("wd-repo", fx.p("app-wd-repo"), fx.p("app-wd-repo"));

    // A folder inside REPO: git resets the whole checkout from there.
    const inside = fx.p("app-wd-inside");
    fx.makeRepo(inside, fx.p("remote-wd-inside.git"));
    mkdirSync(join(inside, "src"));
    writeFileSync(join(inside, "src", "x.txt"), "x\n");
    fx.gitOk(inside, "add", "-A");
    fx.gitOk(inside, "commit", "-qm", "src");
    await point("wd-inside", inside, join(inside, "src"));

    // Another loop's worktree, with that loop's commit on ralph/wd-first.
    const shared = fx.p("app-wd-other");
    fx.makeRepo(shared, fx.p("remote-wd-other.git"));
    const first = fx.p("loops/wd-first");
    fx.makeLoop(first, shared, { WORKTREE: true, MAX_ITER: 1 });
    await fx.runLoop(first, fx.stub("stub-wd-first", ["commit"]));
    await point("wd-other", shared, fx.p("app-wd-other-ralph-wd-first"));

    // REPO is a linked worktree; WORKTREE_DIR is the main checkout, on a
    // detached HEAD, so no branch name gives it away.
    const main = fx.p("app-wd-main");
    fx.makeRepo(main, fx.p("remote-wd-main.git"));
    fx.gitOk(main, "worktree", "add", "-q", "-b", "feature", fx.p("app-wd-main-linked"));
    fx.gitOk(main, "checkout", "-q", "--detach");
    await point("wd-main", fx.p("app-wd-main-linked"), main);

    // REPO itself again, as a linked worktree on a detached HEAD.
    const self = fx.p("app-wd-self");
    fx.makeRepo(self, fx.p("remote-wd-self.git"));
    fx.gitOk(self, "worktree", "add", "-q", "--detach", fx.p("app-wd-self-linked"));
    await point("wd-self", fx.p("app-wd-self-linked"), fx.p("app-wd-self-linked"));

    // The loop's own worktree, found on a detached HEAD at the next start,
    // as sync's rebase leaves it when the loop is killed during it.
    fx.makeRepo(fx.p("app-wd-own"), fx.p("remote-wd-own.git"));
    fx.makeLoop(own, fx.p("app-wd-own"), { WORKTREE: true, MAX_ITER: 1 });
    const So = fx.stub("stub-wd-own", ["commit", "commit"]);
    await fx.runLoop(own, So);
    fx.gitOk(fx.p("app-wd-own-ralph-wd-own"), "checkout", "-q", "--detach");
    await fx.runLoop(own, So);
  });

  test.each([
    ["wd-repo", "is REPO itself"],
    ["wd-inside", "is a folder inside the checkout"],
    ["wd-other", "has ralph/wd-first checked out, not ralph/wd-other"],
    ["wd-main", "is the main checkout of"],
    ["wd-self", "is REPO itself"],
  ])("%s: the start is refused, says why, and runs no agent", (name, why) => {
    const c = cases.find((x) => x.name === name)!;
    expect(read(join(c.loop, "ralph.log"))).toContain(why);
    expect(read(join(c.loop, "ralph.log"))).toContain("refusing to reset a checkout this loop does not own");
    expect(existsSync(join(c.loop, "results.tsv"))).toBe(false);
    expect(existsSync(join(fx.p(`stub-${name}`), "prompt.agent.1"))).toBe(false);
  });
  test.each(["wd-repo", "wd-inside", "wd-other", "wd-main", "wd-self"])("%s: the checkout there is as it was", (name) => {
    const c = cases.find((x) => x.name === name)!;
    expect(snap(c.dir)).toEqual(before.get(name)!);
    expect(fx.gitOk(c.dir, "show-ref", "--verify", "--quiet", `refs/heads/ralph/${name}`)).toBe(false);
  });
  test("the loop's own worktree on a detached HEAD is still its own", () => {
    expect(read(join(own, "ralph.log"))).not.toContain("refusing");
    expect(statuses(own).split(" ")).toHaveLength(2);
  });
});

describe("a new loop's files send the reader to the settings file it has", () => {
  // The template's PROMPT.md said "set QUIET_STOP in config.sh" long after the
  // settings moved to config.json, so every loop `ralph new` wrote sent its
  // human to a file the loop does not have and the harness does not read.
  const home = fx.p("home-names");
  const dir = join(home, "names");
  const files: Record<string, string> = {};

  setup(() => {
    const app = fx.p("app-names");
    fx.makeRepo(app, fx.p("remote-names.git"));
    const r = fx.cli(home, ["new", "names", app]);
    if (r.code !== 0) throw new Error(`ralph new failed: ${r.err}`);
    for (const f of readdirSync(dir)) files[f] = read(join(dir, f));
  });

  test("no file of a new loop names config.sh, which the harness does not read", () => {
    expect(Object.keys(files)).toContain("config.json");
    expect(Object.keys(files).filter((f) => files[f]!.includes("config.sh"))).toEqual([]);
  });
  test("each setting its text says to set is in the file the text names", () => {
    const pointers: string[] = [];
    for (const f of ["PROMPT.md", "PROGRESS.md"]) {
      for (const m of files[f]!.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s+in\s+([\w.-]+\.(?:json|sh))\b/g)) {
        const [key, file] = [m[1]!, m[2]!];
        const settings = files[file] === undefined ? {} : (Bun.JSONC.parse(files[file]) as Record<string, unknown>);
        pointers.push(`${f}: ${key} in ${file}${Object.hasOwn(settings, key) ? "" : " (not there)"}`);
      }
    }
    expect(pointers.length).toBeGreaterThan(0);
    expect(pointers.filter((p) => p.endsWith("(not there)"))).toEqual([]);
  });
});
