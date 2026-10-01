import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  events,
  field,
  Fx,
  join,
  mkNotifier,
  read,
  readConfigValue,
  ROOT,
  setup,
  sleeperGone,
  sq,
  statuses,
  TEMPLATE_CONFIG,
  writeConfig,
} from "../helpers/index.ts";

const fx = new Fx("notify");

/** A question that was already in PROGRESS.md when the loop started. */
function seedOldQuestion(loop: string): void {
  const f = join(loop, "PROGRESS.md");
  const out: string[] = [];
  for (const l of read(f).split("\n")) {
    out.push(l);
    if (l.startsWith("## Needs a decision")) out.push("", "- an older loop left this one here");
  }
  writeFileSync(f, out.join("\n"));
}

describe("NOTIFY_CMD: the loop tells the human instead of failing quietly", () => {
  const app = fx.p("app-nc");
  const remote = fx.p("remote-nc.git");

  // Two limits, then a commit, then a question, then a quiet iteration that
  // changes nothing, then three failures, then MAX_ITER.
  const nc = fx.p("loops/nc");
  const ncLog = fx.p("notify-nc.log");
  let ncStub = "";

  const ncs = fx.p("loops/ncs");
  const ncsLog = fx.p("notify-ncs.log");

  const nq = fx.p("loops/nq");
  const nqLog = fx.p("notify-nq.log");

  const nh = fx.p("loops/nh");
  const hangPid = fx.p("notify-hang.pid");

  const nf = fx.p("loops/nf");

  const nr = fx.p("loops/nr");
  const nrLog = fx.p("notify-nr.log");
  let nrRc = -1;

  const ns = fx.p("loops/ns");
  const nsLog = fx.p("notify-ns.log");
  let nsRc = -1;

  setup(async () => {
    fx.makeRepo(app, remote);

    ncStub = fx.stub("stub-nc", ["limit", "limit", "commit", "decide", "nothing", "fail", "fail", "fail"]);
    mkNotifier(ncLog, fx.p("notify-nc.sh"));
    fx.makeLoop(nc, app, {
      WORKTREE: true,
      MAX_ITER: 6,
      ESCALATE_AFTER: 3,
      ITER_TIMEOUT: 10,
      VERIFY_CMD: "./measure.sh",
      NOTIFY_CMD: sq(fx.p("notify-nc.sh")),
    });
    // Only what an agent of *this* run writes under that heading is news.
    seedOldQuestion(nc);
    await fx.runLoop(nc, ncStub);

    // A question settled, or the list reordered, changes the section without
    // asking anything new.
    const ncsStub = fx.stub("stub-ncs", ["decide", "settle", "nothing"]);
    mkNotifier(ncsLog, fx.p("notify-ncs.sh"));
    fx.makeLoop(ncs, app, { MAX_ITER: 3, NOTIFY_CMD: sq(fx.p("notify-ncs.sh")) });
    seedOldQuestion(ncs);
    await fx.runLoop(ncs, ncsStub);

    // A keep and a quiet on their own say nothing; the stop says why it
    // stopped. QUIET_STOP, not MAX_ITER, so the other stop reason is exercised.
    const nqStub = fx.stub("stub-nq", ["commit", "nothing"]);
    mkNotifier(nqLog, fx.p("notify-nq.sh"));
    fx.makeLoop(nq, app, {
      WORKTREE: true,
      MAX_ITER: 5,
      QUIET_STOP: 1,
      VERIFY_CMD: "./measure.sh",
      NOTIFY_CMD: sq(fx.p("notify-nq.sh")),
    });
    await fx.runLoop(nq, nqStub);

    // A notifier that hangs is killed with its process group at NOTIFY_TIMEOUT
    // and the loop carries on — the stuck event lands in iteration 1.
    const nhStub = fx.stub("stub-nh", ["fail", "commit", "nothing"]);
    const hang = fx.p("notify-hang.sh");
    writeFileSync(hang, `#!/bin/sh\nsleep 999 &\nprintf '%s\\n' "$!" > ${sq(hangPid)}\nwait\n`);
    chmodSync(hang, 0o755);
    fx.makeLoop(nh, app, {
      WORKTREE: true,
      MAX_ITER: 3,
      ESCALATE_AFTER: 1,
      NOTIFY_TIMEOUT: 1,
      VERIFY_CMD: "./measure.sh",
      NOTIFY_CMD: sq(hang),
    });
    await fx.runLoop(nh, nhStub);

    // NOTIFY_CMD is a shell command, not a program: `exit 7`, and no such file.
    const nfStub = fx.stub("stub-nf", ["commit", "nothing"]);
    fx.makeLoop(nf, app, { WORKTREE: true, MAX_ITER: 2, NOTIFY_CMD: "exit 7", VERIFY_CMD: "./measure.sh" });
    await fx.runLoop(nf, nfStub);

    // A start that never ran an iteration: REPO is not a checkout.
    mkNotifier(nrLog, fx.p("notify-nr.sh"));
    fx.fresh(nr);
    mkdirSync(nr, { recursive: true });
    mkdirSync(fx.p("not-a-checkout"));
    copyFileSync(join(ROOT, "template/PROMPT.md"), join(nr, "PROMPT.md"));
    copyFileSync(join(ROOT, "template/PROGRESS.md"), join(nr, "PROGRESS.md"));
    writeConfig(nr, { REPO: fx.p("not-a-checkout"), NOTIFY_CMD: sq(fx.p("notify-nr.sh")) });
    nrRc = await fx.runLoop(nr, fx.stub("stub-nr"));

    // A start refused because SETUP_CMD failed.
    const nsStub = fx.stub("stub-ns", ["nothing"]);
    mkNotifier(nsLog, fx.p("notify-ns.sh"));
    fx.makeLoop(ns, app, { WORKTREE: true, MAX_ITER: 1, SETUP_CMD: "exit 3", NOTIFY_CMD: sq(fx.p("notify-ns.sh")) });
    nsRc = await fx.runLoop(ns, nsStub);
  });

  test("one notification per event a human needs, and none for a keep or a quiet", () => {
    expect(events(ncLog)).toEqual(["limit", "limit-clear", "decision", "stuck", "stopped"]);
  });
  test("the verdicts are what they are without a notifier", () => {
    expect(statuses(nc)).toBe("ratelimit ratelimit keep quiet quiet error error error");
  });
  test("the loop is named in the event", () => {
    expect(field(2, "stuck", ncLog)).toBe("nc");
  });
  test("the loop directory is in the event", () => {
    expect(field(4, "stuck", ncLog)).toBe(nc);
  });
  test("the iteration is in the event", () => {
    expect(field(3, "stuck", ncLog)).toBe("6");
  });
  test("the limit event says what claude said", () => {
    expect(field(5, "limit", ncLog)).toContain("hit your limit");
  });
  test("the stuck event says how many iterations in a row", () => {
    expect(field(5, "stuck", ncLog)).toContain("3 iterations in a row");
  });
  test("the stop event says which stop it was", () => {
    expect(field(5, "stopped", ncLog)).toContain("MAX_ITER=6");
  });
  test("the decision event carries what the agent wrote", () => {
    expect(field(5, "decision", ncLog)).toContain("only a human can settle this one");
  });
  // The agent writes the message, so it is the notifier's command that must not
  // be built out of it. This one holds a quote and a $(touch ...); it arrives
  // as text or it runs.
  test("a message holding shell syntax reaches the notifier as text", () => {
    expect(field(5, "decision", ncLog)).toContain("$(touch");
  });
  test("and nothing in it ran", () => {
    expect(existsSync(join(ncStub, "OWNED"))).toBe(false);
  });
  test("the log still says everything the notifier was told", () => {
    expect(read(join(nc, "ralph.log"))).toContain("Needs a decision");
  });

  test("a question settled, or the list reordered, is not a new question", () => {
    expect(events(ncsLog)).toEqual(["decision", "stopped"]);
  });

  test("a loop that ships and then goes quiet notifies only the stop", () => {
    expect(events(nqLog)).toEqual(["stopped"]);
  });
  test("and the stop event says it was QUIET_STOP", () => {
    expect(field(5, "stopped", nqLog)).toContain("shipped nothing");
  });

  test("a hanging notifier does not hold up the loop", () => {
    expect(statuses(nh)).toBe("error keep quiet");
  });
  test("the hanging notifier was killed with its process group", () => {
    expect(sleeperGone(hangPid)).toBe(true);
  });
  test("and the log says a notification was killed", () => {
    expect(read(join(nh, "ralph.log"))).toMatch(/notify: .* timed out/);
  });

  test("a notifier that fails is ignored", () => {
    expect(statuses(nf)).toBe("keep quiet");
  });
  test("and its exit status is logged rather than swallowed", () => {
    expect(read(join(nf, "ralph.log"))).toContain("notify: stopped exited 7");
  });

  test("a refused start notifies, once", () => {
    expect(events(nrLog)).toEqual(["refused"]);
  });
  test("and says why it was refused", () => {
    expect(field(5, "refused", nrLog)).toContain("not a git checkout");
  });
  // Guards: the refusal must still do what it did before it also notified.
  test("the refusal still exits 2", () => {
    expect(nrRc).toBe(2);
  });
  test("the refusal is still in the log the reader is sent to", () => {
    expect(read(join(nr, "ralph.log"))).toContain("not a git checkout");
  });

  test("a start refused because SETUP_CMD failed notifies too", () => {
    expect(events(nsLog)).toEqual(["refused"]);
  });
  test("and names SETUP_CMD", () => {
    expect(field(5, "refused", nsLog)).toContain("SETUP_CMD");
  });
  test("that refusal still exits 1", () => {
    expect(nsRc).toBe(1);
  });
  test("and still leaves no half-built worktree behind", () => {
    expect(existsSync(fx.p("app-nc-ralph-ns"))).toBe(false);
  });

  // The template must not ship a notifier that runs: a fresh loop is silent
  // until its human picks one, and both examples are there to be uncommented.
  test("the template leaves NOTIFY_CMD empty, with its examples commented out", () => {
    expect(readConfigValue(TEMPLATE_CONFIG, "NOTIFY_CMD")).toBe("");
    const tpl = read(TEMPLATE_CONFIG);
    expect(tpl).toContain("osascript");
    expect(tpl).toContain("api.telegram.org");
  });
});
