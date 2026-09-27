import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Fx, ROOT, count, join, num, read, setup, statuses } from "../helpers/index.ts";

const fx = new Fx("progress");

const size = (path: string) => statSync(path).size;
/** Every prompt the stub recorded for the agent. */
const agentPrompts = (stub: string) =>
  readdirSync(stub)
    .filter((f) => f.startsWith("prompt.agent."))
    .map((f) => join(stub, f));

describe("the prompt is bounded whatever shape PROGRESS.md is in", () => {
  // PROGRESS_KEEP counts '### ' entries under a '## Log' heading, and the agent
  // is what writes both. Drop the heading and the cap counted nothing and said
  // nothing, so PROGRESS.md went into every prompt for the rest of the run. The
  // bound is now on the bytes injected, which no shape can switch off, and the
  // file is never touched because it is the loop's whole memory.
  const app = fx.p("app-cap");
  const home = fx.p("home-cap");
  const D = join(home, "cap");
  const D1 = join(home, "cap1");
  const D2 = join(home, "cap2");
  let S = "";
  let S1 = "";
  let S2 = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-cap.git"));
    S = fx.stub("stub-cap", ["grow-progress", "grow-progress", "grow-progress", "grow-progress"]);
    fx.makeLoop(D, app, { MAX_ITER: 4, PROGRESS_MAX_BYTES: 4000 });
    // No '## Log' heading anywhere: what the agent left behind after reshaping
    // its own notes. The head sections stay, because the head is what has to
    // survive.
    writeFileSync(
      join(D, "PROGRESS.md"),
      "# Progress\n\n## Needs a decision\n\n- nothing yet\n\n## What I keep in mind\n\n" +
        "the oldest note, written when the file was still small\n",
    );
    await fx.runLoop(D, S, { env: { RALPH_HOME: home } });

    // Same bound, the other hole: the heading is there and correct, and the cap
    // still does nothing because it counts entries and one entry has no size limit.
    S1 = fx.stub("stub-cap1", ["nothing", "nothing"]);
    fx.makeLoop(D1, app, { MAX_ITER: 2, PROGRESS_KEEP: 8, PROGRESS_MAX_BYTES: 4000 });
    let big = "# Progress\n\n## Log\n\n### 2026-01-01 10:00 — iteration 1\n\n";
    for (let i = 0; i < 300; i++) big += `one entry, and it is enormous: line ${i}\n`;
    writeFileSync(join(D1, "PROGRESS.md"), big);
    await fx.runLoop(D1, S1, { env: { RALPH_HOME: home } });

    // A healthy loop must not meet the bound at all, or it is not a backstop.
    S2 = fx.stub("stub-cap2", ["nothing"]);
    fx.makeLoop(D2, app, { MAX_ITER: 1 });
    await fx.runLoop(D2, S2, { env: { RALPH_HOME: home } });
  });

  test("the file really did grow past the bound, so the checks below mean something", () => {
    expect(size(join(D, "PROGRESS.md"))).toBeGreaterThan(12000);
  });
  // Two iterations of notes are ~7200 bytes. Unbounded, the prompt grew by all
  // of them; bounded, only the verdict rows and the byte counts in the notice move.
  test("the prompt stops growing once the file is over the bound", () => {
    expect(size(join(S, "prompt.agent.4")) - size(join(S, "prompt.agent.2"))).toBeLessThan(1000);
  });
  test("the prompt says where the rest of the file is", () => {
    expect(read(join(S, "prompt.agent.4"))).toContain("Cut off here by the harness");
  });
  test("the newest prompt still holds the head of the file", () => {
    expect(read(join(S, "prompt.agent.4"))).toMatch(/^## Needs a decision/m);
  });
  test("what the bound cut is really cut", () => {
    expect(read(join(S, "prompt.agent.4"))).not.toMatch(/note 3.59/);
  });
  // The file is the loop's memory. Bounding the prompt must not destroy it.
  test("PROGRESS.md itself is left whole on disk", () => {
    const p = read(join(D, "PROGRESS.md"));
    expect(p).toContain("the oldest note");
    expect(p).toMatch(/note 3.59/);
  });
  test("the log says it is clipping, once and not once per iteration", () => {
    expect(count(read(join(D, "ralph.log")), /over PROGRESS_MAX_BYTES/)).toBe(1);
  });
  // The entry cap saw no shape it understood and used to pass over that in
  // silence, which is how a run could go for days with no bound but this one.
  test("the log says the entry cap can see nothing to count", () => {
    expect(read(join(D, "ralph.log"))).toContain("the entry cap does nothing");
  });
  // Measured over PROMPT.md, so a template that grows does not move the bar:
  // PROGRESS_MAX_BYTES of memory plus the harness's own sections, and no more.
  test("one entry under the entry cap is still bounded by bytes", () => {
    expect(size(join(S1, "prompt.agent.2")) - size(join(D1, "PROMPT.md"))).toBeLessThan(8000);
  });
  test("the entry cap left that file alone, as it should", () => {
    expect(count(read(join(D1, "PROGRESS.md")), /^### /)).toBe(1);
  });
  test("a loop under the bound gets its whole file, with no notice", () => {
    expect(read(join(S2, "prompt.agent.1"))).not.toContain("Cut off here");
    expect(read(join(D2, "ralph.log"))).not.toContain("over PROGRESS_MAX_BYTES");
  });
  test("and the default bound is not so tight that a real PROGRESS.md meets it", () => {
    expect(size(join(ROOT, "template/PROGRESS.md"))).toBeLessThan(120000);
  });
});

describe("a file the harness re-reads every iteration, gone mid-run", () => {
  // PROMPT.md and PROGRESS.md were checked once, at the start, and then read
  // again on every iteration. The agent has write access to the loop directory,
  // so one of them going missing mid-run is not exotic, and the harness carried
  // on: with PROMPT.md gone the next agent was handed its own notes, the verdict
  // table and "Run one iteration now", with no job at all.
  const app = fx.p("app-gone");
  const loop = fx.p("loops/gone");
  const loop2 = fx.p("loops/gone2");
  const loop3 = fx.p("loops/gone3");
  let S = "";
  let S2 = "";
  let S3 = "";

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-gone.git"));
    S = fx.stub("stub-gone", ["drop-prompt", "commit", "commit", "nothing"], ["ACCEPT", "ACCEPT", "ACCEPT", "ACCEPT"]);
    fx.makeLoop(loop, app, { WORKTREE: true, REVIEW: true, MAX_ITER: 4, VERIFY_CMD: "./measure.sh" });
    await fx.runLoop(loop, S);

    // The same hole in the other file, and its symptom is a lie rather than a
    // silence: every later prompt told the agent its memory had been cut off at
    // "" bytes and to read the rest on disk — of a file that is not there.
    S2 = fx.stub("stub-gone2", ["drop-progress", "nothing", "nothing", "nothing"]);
    fx.makeLoop(loop2, app, { MAX_ITER: 4 });
    await fx.runLoop(loop2, S2);

    // The guard, and the reason it is here: -s is the tempting test and it is
    // the wrong one. A loop whose agent has not written its first entry yet has
    // an empty PROGRESS.md, and it must still run.
    S3 = fx.stub("stub-gone3", ["nothing", "nothing", "nothing"]);
    fx.makeLoop(loop3, app, { MAX_ITER: 3 });
    writeFileSync(join(loop3, "PROGRESS.md"), "");
    await fx.runLoop(loop3, S3);
  });

  test("the loop stops rather than run an agent with no job", () => {
    expect(num(join(S, "agent_calls"))).toBe(1);
  });
  test("the log names the file it could not read", () => {
    expect(read(join(loop, "ralph.log"))).toContain("stopping: PROMPT.md is gone");
  });
  test("no prompt reached the agent without the job in it", () => {
    const prompts = agentPrompts(S);
    expect(prompts.length).toBeGreaterThan(0);
    for (const f of prompts) expect(read(f)).toMatch(/^## The job/m);
  });
  // Asked with no job, the reviewer judges the diff against an empty brief and
  // cannot say "not what the loop asked for" — the one thing it is there for.
  test("the reviewer is never asked to judge against a job that is not there", () => {
    expect(num(join(S, "review_calls"))).toBe(0);
  });
  test("the commit made in that iteration still ships, marked unreviewed", () => {
    expect(statuses(loop)).toBe("keep:unreviewed");
  });
  test("and the recorded reason says why there was no review", () => {
    expect(read(join(loop, "results.tsv"))).toContain("no job to review against");
  });
  test("the loop stops when its memory is gone too", () => {
    expect(num(join(S2, "agent_calls"))).toBe(1);
  });
  test("the log names PROGRESS.md", () => {
    expect(read(join(loop2, "ralph.log"))).toContain("stopping: PROGRESS.md is gone");
  });
  test("no prompt claims the memory was clipped when there is no memory", () => {
    for (const f of agentPrompts(S2)) expect(read(f)).not.toContain("Cut off here");
  });
  test("an empty PROGRESS.md is not a missing one", () => {
    expect(num(join(S3, "agent_calls"))).toBe(3);
  });
  test("a loop with both files ends at MAX_ITER, not at this check", () => {
    expect(read(join(loop3, "ralph.log"))).toContain("hit MAX_ITER=3");
  });
});

describe("the overflow path is a path, not an awk escape sequence", () => {
  // cap_progress moved old Log entries out of PROGRESS.md with
  // `awk -v over="$DIR/.progress-overflow.$$"`, and awk processes escape
  // sequences in a -v value. So a loop directory holding a backslash reached awk
  // as a *different* path: an unknown escape such as `\q` loses its backslash,
  // which maps one real directory onto another. If nothing exists there, the cap
  // silently does nothing for the rest of the run; if something does, the
  // overflow is written there and PROGRESS.md is truncated anyway — the entries
  // gone and the log saying they were archived.
  const app = fx.p("app-bs");
  // The control: the same fixture with an ordinary path. It passes before and
  // after, so a fix that switches the cap off to dodge the problem fails here.
  const plain = fx.p("loops/bs-plain");
  // Arm one: `d\qrop` mangles to `dqrop`, which this run never creates.
  const drop = `${fx.T}/d\\qrop/loop`;
  // Arm two, the one that loses work: the mangled path is a real directory.
  const steal = `${fx.T}/s\\qib/loop`;
  const stranger = fx.p("sqib/loop");

  setup(async () => {
    fx.makeRepo(app, fx.p("remote-bs.git"));
    const S = fx.stub("stub-bs", ["nothing", "nothing", "nothing"]);

    fx.makeLoop(plain, app, { MAX_ITER: 1, PROGRESS_KEEP: 8 });
    seedLog(plain);
    await fx.runLoop(plain, S);

    fx.makeLoop(drop, app, { MAX_ITER: 1, PROGRESS_KEEP: 8 });
    seedLog(drop);
    await fx.runLoop(drop, S);

    mkdirSync(stranger, { recursive: true });
    fx.makeLoop(steal, app, { MAX_ITER: 1, PROGRESS_KEEP: 8 });
    seedLog(steal);
    await fx.runLoop(steal, S);
  });

  test("an ordinary loop directory archives its four oldest entries", () => {
    expect(entries(join(plain, "PROGRESS-archive.md"))).toEqual([1, 2, 3, 4]);
  });
  test("and keeps the other eight", () => {
    expect(count(read(join(plain, "PROGRESS.md")), /^### /)).toBe(8);
  });
  test("a backslash in the loop directory does not stop the cap archiving", () => {
    expect(entries(join(drop, "PROGRESS-archive.md"))).toEqual([1, 2, 3, 4]);
  });
  test("and PROGRESS.md is trimmed to the eight entries it keeps", () => {
    expect(count(read(join(drop, "PROGRESS.md")), /^### /)).toBe(8);
  });
  test("awk was handed a path it could open", () => {
    expect(read(join(drop, "ralph.log"))).not.toContain("progress-overflow");
  });
  test("no Log entry is lost: all twelve are in PROGRESS.md or the archive", () => {
    expect(entries(join(steal, "PROGRESS.md"), join(steal, "PROGRESS-archive.md"))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });
  test("the log does not claim to have archived entries it destroyed", () => {
    expect(read(join(steal, "ralph.log"))).toContain("moved 4 old Log entries");
    expect(count(read(join(steal, "PROGRESS-archive.md")), /^### /)).toBe(4);
  });
  test("nothing is written into a directory the loop does not own", () => {
    expect(readdirSync(stranger)).toEqual([]);
  });
  // A guard: passes before too, because the un-mangled name is the one `rm -f`
  // was already given. It fails a fix that stops cleaning the overflow up.
  test("the overflow file does not outlive the iteration", () => {
    expect(readdirSync(steal).filter((f) => f.startsWith(".progress-overflow."))).toEqual([]);
  });
});

/** Twelve Log entries under the template's head sections, newest first, against PROGRESS_KEEP=8. */
function seedLog(dir: string): void {
  const tpl = readFileSync(join(ROOT, "template/PROGRESS.md"), "utf8");
  const head = tpl.split("\n");
  let out = `${head.slice(0, head.findIndex((l) => l.startsWith("## Log"))).join("\n")}\n## Log\n\n`;
  for (let i = 12; i >= 1; i--) {
    out += `### 2026-01-${String(i).padStart(2, "0")} 10:00 — iteration ${i}\n\nentry ${i}\n\n`;
  }
  writeFileSync(join(dir, "PROGRESS.md"), out);
}

/**
 * The iteration numbers held by the files named, in order. Given both files it
 * answers "which entries still exist anywhere", which is the question the cap
 * must never change the answer to.
 */
function entries(...files: string[]): number[] {
  return files
    .flatMap((f) => read(f).split("\n"))
    .filter((l) => l.startsWith("### "))
    .map((l) => Number(l.replace(/.*iteration /, "")))
    .sort((a, b) => a - b);
}
