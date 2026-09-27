import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import {
  cliPath,
  count,
  Fx,
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
    fx.makeLoop(i, appI, { WORKTREE: true, PUSH: true, MAX_ITER: 2 });
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
    fx.makeLoop(n, fx.p("my app"), { WORKTREE: true, PUSH: true, REVIEW: true, MAX_ITER: 2, VERIFY_CMD: "./measure.sh" });
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

  const srcDollar = `${T}/pre$HOME-src`;
  const ran = fx.p("SOURCED-RAN");
  const srcTick = `${T}/q\`touch ${ran}\`-src`;
  const srcSub = `${T}/s$(echo no)-src`;
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
    // settings of such a loop runs a command out of a directory name.
    fx.makeRepo(srcTick, fx.p("remote-src2.git"));
    fx.cli(home, ["new", "tick", srcTick]);
    rmSync(ran, { force: true });
    tickRepo = repoOf("tick");
    tickRan = existsSync(ran);

    // $(...) is the same substitution spelled differently, and a " ends the
    // string early — which swallows the settings after it rather than failing.
    fx.makeRepo(srcSub, fx.p("remote-src3.git"));
    fx.cli(home, ["new", "sub", srcSub]);
    fx.makeRepo(srcQuote, fx.p("remote-src4.git"));
    fx.cli(home, ["new", "quote", srcQuote]);

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
  test("a backtick in the repo path stays text and is not run", () => {
    expect(tickRan).toBe(false);
  });
  test("and that path too arrives whole", () => {
    expect(tickRepo).toBe(srcTick);
  });
  test("a $(...) in the repo path is not run", () => {
    expect(repoOf("sub")).toBe(srcSub);
  });
  test('a " in the repo path does not end the string early', () => {
    expect(repoOf("quote")).toBe(srcQuote);
  });
  test("so the settings after REPO are still read", () => {
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
