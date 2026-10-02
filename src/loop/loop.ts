import { accessSync, constants, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hour, nowSec, stampMinutes } from "../lib/clock.ts";
import { type Config, defaults, limitPattern, pushProblem, pushWord } from "../lib/config.ts";
import { isCheckout, rewrite, sameDir } from "../lib/files.ts";
import type { Log } from "../lib/log.ts";
import { type Bounded, DEV_NULL, IS_WIN, type Ran, claudeProblem, nap, run, runBounded, shellCommand } from "../lib/proc.ts";
import { keepRows, readResults, record } from "../lib/results.ts";
import { shq } from "../lib/shq.ts";
import { chomp, headBytes, lastNonBlank, section, splitLines, stripEscapes, tailLines } from "../lib/text.ts";
import { APPROVE_PLAN, CHILD_FILE, REFUSED, STEER_HOOK, refPrefix, sortRefs } from "../paths.ts";
import { type Window, inWindow, parseHours } from "./active-hours.ts";
import { addCost, addTokens, claudeText } from "./cost.ts";
import { resetAt, limitLine, type Reset } from "./limits.ts";
import { type Checks, readChecks } from "./merge.ts";
import { ARCHIVE_HEADER, capProgress, decisions, injectProgress } from "./progress.ts";

// One loop over one repository. Every iteration is a NEW `claude -p` with an
// empty context; the only thing that crosses from one to the next is
// PROGRESS.md on disk, which the agent rewrites at the end of its turn.
//
// The gate is a commit, judged outside the model. If HEAD did not move, the
// iteration found nothing and the loop looks less often rather than giving up.
// If it moved and WORKTREE is on, the harness checks the new commits (frozen
// files, VERIFY_CMD, an optional read-only reviewer), resets the ones that
// fail, and pushes the rest itself. The agent commits; it never pushes.

/**
 * The first of `names` in `dir` that is not a regular file this process can
 * read, or null. `-f` as well as `-r`: a directory is readable and cannot be
 * read as a file, and a loop holding a PROMPT.md/ is still a loop with no job.
 */
export function missingFile(dir: string, ...names: string[]): string | null {
  for (const n of names) {
    try {
      if (!statSync(join(dir, n)).isFile()) return n;
      accessSync(join(dir, n), constants.R_OK);
    } catch {
      return n;
    }
  }
  return null;
}

/**
 * How the agent is started: a fresh `claude -p` with no permission prompts, the
 * loop directory readable, and its answer as JSON so the run's cost can be read.
 * DENY patterns are enforced by claude ahead of the skipped permissions.
 *
 * With PLAN_FIRST it starts in plan mode instead, with bypass available but not
 * on. `claude -p` offers ExitPlanMode only when something can answer the
 * approval prompt, so the harness's own MCP tool answers it: it approves the
 * plan and switches the session to bypassPermissions, and denies the rest.
 */
export function agentArgs(c: Config, dir: string): string[] {
  const perms = c.PLAN_FIRST
    ? [
        "--permission-mode",
        "plan",
        "--allow-dangerously-skip-permissions",
        "--mcp-config",
        join(dir, ".plan-mcp.json"),
        "--permission-prompt-tool",
        "mcp__ralph__approve",
      ]
    : ["--dangerously-skip-permissions"];
  const args = ["-p", ...perms, "--add-dir", dir, "--model", c.MODEL];
  for (const d of c.ADD_DIRS) args.push("--add-dir", d);
  if (c.LIVE_STEER) args.push("--settings", join(dir, ".agent-settings.json"));
  for (const d of c.DENY) args.push("--disallowedTools", d);
  args.push("--output-format", "json");
  return args;
}

/** How the reviewer is started: read-only tools, no MCP servers, nobody to ask. */
export function reviewerArgs(c: Config, dir: string): string[] {
  return [
    "-p",
    "--restricted",
    "--tools",
    "Read,Grep,Glob",
    "--strict-mcp-config",
    "--permission-prompts",
    "none",
    "--add-dir",
    dir,
    "--model",
    c.REVIEW_MODEL || c.MODEL,
    "--output-format",
    "json",
  ];
}

/** The MCP server behind PLAN_FIRST's --permission-prompt-tool; the plan it approves lands in `.plan.md`. */
export function planMcpConfig(dir: string): object {
  return {
    mcpServers: { ralph: { command: process.execPath, args: [APPROVE_PLAN], env: { RALPH_PLAN_FILE: join(dir, ".plan.md") } } },
  };
}

/**
 * The PreToolUse hook that delivers `ralph steer` to the iteration in flight.
 * Claude Code runs hook commands in a shell: Git Bash on Windows when Git for
 * Windows is there, which the harness needs anyway. Its paths go with forward
 * slashes there, which Windows takes and which shq then leaves bare, so an
 * ordinary path reads the same to bash and to PowerShell.
 */
export function agentSettings(): object {
  const path = (p: string) => (IS_WIN ? p.split("\\").join("/") : p);
  return {
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${shq(path(process.execPath))} ${shq(path(STEER_HOOK))}` }] }],
    },
  };
}

export class Stop extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

interface Review {
  status: "accept" | "reject" | "unavailable";
  reason: string;
  cost: string;
  tokens: string;
}

export class Loop {
  readonly name: string;
  readonly results: string;
  readonly promptFile: string;
  readonly limitRe: RegExp;
  work: string;
  iter = 0;
  private quiet = 0;
  private trouble = 0;
  private errors = 0;
  private limits = 0;
  private stopWhy = "";
  private broken = false;
  private ghOk = false;
  private window: Window | null = null;
  private healthState: "" | "ok" | "fail" = "";
  private healthWhy = "";
  private healthSince = "";
  private churnText: [number, string][] = [];
  private churnKept = 0;
  private capWarned = false;
  private injectWarned = false;
  private landWaiting = false;
  /** The loop has ended by itself: a pull request opened from here on is not a draft. */
  private ended = false;
  /**
   * This process holds ralph.lock. Before it does, .child may name the command
   * of a loop that is running, so a command run before then (a refusal's
   * notifier) does not write it.
   */
  holdsLock = false;
  /** The last iteration's commits that VERIFY_CMD failed, for the next prompt. */
  private verifyFailed: { before: string; after: string; tail: string } | null = null;

  constructor(
    readonly dir: string,
    readonly cfg: Config,
    readonly log: Log,
  ) {
    this.name = basename(dir);
    this.results = join(dir, "results.tsv");
    this.promptFile = join(dir, ".prompt");
    this.limitRe = limitPattern(cfg);
    this.work = cfg.REPO;
  }

  private p(file: string): string {
    return join(this.dir, file);
  }

  private read(file: string): string {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }

  // ------------------------------------------------------------ primitives

  /** git in the work directory (or wherever `cwd` says), stderr to the log. */
  private git(args: string[], opts: { cwd?: string; quiet?: boolean; toLog?: boolean } = {}): Promise<Ran> {
    return run(["git", ...args], {
      cwd: opts.cwd,
      errTo: opts.quiet ? DEV_NULL : this.log.file,
      outTo: opts.toLog ? this.log.file : undefined,
    });
  }

  private async gitOut(args: string[], opts: { cwd?: string; quiet?: boolean } = {}): Promise<string> {
    return (await this.git(args, opts)).stdout.trim();
  }

  private async gitOk(args: string[], opts: { cwd?: string; quiet?: boolean; toLog?: boolean } = {}): Promise<boolean> {
    return (await this.git(args, opts)).code === 0;
  }

  /**
   * `git fetch <args>`, bounded like the pushes. A connection that stalls (a
   * VPN gone, a credential helper waiting on a browser nobody sees) does not
   * fail by itself, and the loop sat in its fetch for good, logging nothing
   * while `ralph status` said running.
   */
  private async fetch(args: string[], cwd?: string): Promise<boolean> {
    const r = await this.bounded(300, ["git", "fetch", "-q", ...args], { out: this.log.file, cwd });
    if (r.timedOut) this.log.line(`git fetch ${args.join(" ")} timed out after 300s`);
    return r.rc === 0 && !r.timedOut;
  }

  private bounded(
    secs: number,
    argv: string[],
    opts: { stdin?: string; out: string; err?: string; env?: Record<string, string>; cwd?: string },
  ) {
    return runBounded(secs, argv, {
      ...opts,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
      pollGapMax: this.cfg.POLL_GAP_MAX,
      mark: this.holdsLock ? this.p(CHILD_FILE) : undefined,
    });
  }

  /** A *_CMD setting, bounded: the user's own text, run by bash. */
  private shell(secs: number, command: string, opts: { out: string; env?: Record<string, string>; cwd?: string }) {
    const sh = shellCommand(command);
    return this.bounded(secs, sh.argv, { ...opts, env: { ...opts.env, ...sh.env } });
  }

  missing(...names: string[]): string | null {
    return missingFile(this.dir, ...names);
  }

  private harnessPushes(): boolean {
    return this.cfg.WORKTREE && (this.cfg.PUSH === true || this.cfg.PUSH === "pr");
  }

  // ------------------------------------------------------------ telling a human

  /**
   * Tell the human. The event reaches NOTIFY_CMD in the environment and never
   * in its text, so a message holding a quote, a newline or a $(...) cannot
   * become part of the command that runs. A notifier is not a gate: bounded by
   * NOTIFY_TIMEOUT, its exit status dropped, and it returns nothing a gate
   * could read.
   */
  async notify(event: string, message: string): Promise<void> {
    if (!this.cfg.NOTIFY_CMD) return;
    const secs = this.cfg.NOTIFY_TIMEOUT >= 1 ? this.cfg.NOTIFY_TIMEOUT : 30;
    const r = await this.shell(secs, this.cfg.NOTIFY_CMD, {
      out: this.log.file,
      env: {
        RALPH_EVENT: event,
        RALPH_LOOP: this.name,
        RALPH_DIR: this.dir,
        RALPH_ITER: String(this.iter),
        RALPH_MESSAGE: message,
      },
    });
    if (r.timedOut) this.log.line(`notify: ${event} timed out after ${secs}s and its process group was killed`);
    else if (r.rc !== 0) this.log.line(`notify: ${event} exited ${r.rc} (ignored; a notifier is not a gate)`);
  }

  /**
   * A start that will not run an iteration: the one a human most needs to hear
   * about, because a loop that never started has nothing else to notice. One
   * place, so every refusal reaches the human and the next one added does too.
   */
  async refuse(message: string, code = 1): Promise<never> {
    this.log.line(message);
    await this.notify("refused", message);
    throw new Stop(code);
  }

  // ------------------------------------------------------------ git

  /**
   * Make the worktree what HEAD holds: "" when git did, otherwise what failed.
   * The gates run on the files on disk, so a clean that did not happen means
   * the gates judge the agent's uncommitted edits. Measured, each of these
   * kept a commit whose own check failed: a reset into a directory the agent
   * made read-only, which exits 128 and leaves the edit, and an fsmonitor hook
   * the agent configured, which tells git that no file changed. `clean` needs
   * -f twice to remove a repository of its own inside the worktree, such as a
   * clone the agent looked at. `git status` is not asked afterwards: a
   * repository holding README and readme shows one modified after every reset
   * on a case-insensitive disk, and asking would stop that loop for good.
   */
  private async cleanTree(): Promise<string> {
    const gitdir = resolve(process.cwd(), await this.gitOut(["rev-parse", "--git-dir"]));
    if (existsSync(join(gitdir, "rebase-merge")) || existsSync(join(gitdir, "rebase-apply"))) {
      await this.git(["rebase", "--abort"], { quiet: true });
    }
    rmSync(join(gitdir, "index.lock"), { force: true });
    const git = (...args: string[]) => run(["git", "-c", "core.fsmonitor=false", ...args]);
    for (const args of [
      ["reset", "-q", "--hard", "HEAD"],
      ["clean", "-qffd"],
    ]) {
      const r = await git(...args);
      if (r.code !== 0) return `git ${args[0]} exited ${r.code}: ${splitLines(r.stderr).find((l) => /\S/.test(l)) ?? ""}`;
    }
    return "";
  }

  /**
   * Put ralph/<name> back at `sha`, whatever the agent did — left the branch,
   * rewrote its history, or deleted the ref out from under the worktree. -B
   * remakes a branch that is gone, so a deleted ref costs one iteration.
   */
  private async revertTo(sha: string): Promise<boolean> {
    if (!(await this.gitOk(["checkout", "-q", "-f", "-B", `ralph/${this.name}`, sha]))) return false;
    await this.git(["clean", "-qfd"]);
    return true;
  }

  /**
   * Keep a commit the gates threw away under refs/ralph/<name>/<ns>/, so a
   * human can still get it back, and let go of the oldest beyond REF_KEEP: a
   * ref is the only thing keeping such a commit reachable, so unbounded these
   * stop `git gc` from ever reclaiming it. Oldest by the epoch in the name,
   * numerically. The loop's name is in the ref because refs belong to the
   * repository, which other loops share: without it a loop pruned theirs too.
   * Refs an older version saved (refs/ralph/<ns>/<epoch>-<iter>) name no loop,
   * so no loop prunes them; `ralph review` lists them on their own.
   */
  private async saveRef(ns: string, commit: string): Promise<void> {
    const prefix = refPrefix(this.name, ns);
    await this.git(["update-ref", `${prefix}${nowSec()}-${this.iter}`, commit], { quiet: true });
    if (!(this.cfg.REF_KEEP >= 1)) return;
    const refs = splitLines(await this.gitOut(["for-each-ref", "--format=%(refname)", prefix]));
    sortRefs(refs);
    for (const ref of refs.slice(this.cfg.REF_KEEP)) await this.git(["update-ref", "-d", ref]);
  }

  /**
   * Whether two checkouts belong to one repository: the directory each one's
   * git keeps its objects in is the same. A repository git cannot name belongs
   * to nobody. When both came back unknown and unknown matched unknown, which
   * bun's realpath made of every path holding a backslash, a stranger's
   * checkout passed as this loop's worktree and was reset and cleaned.
   */
  private async sameRepo(a: string, b: string): Promise<boolean> {
    const common = async (path: string) => {
      const r = await this.git(["-C", path, "rev-parse", "--git-common-dir"], { quiet: true });
      const dir = r.stdout.trim();
      return r.code === 0 && dir ? resolve(path, dir) : "";
    };
    const [x, y] = [await common(a), await common(b)];
    return x !== "" && y !== "" && sameDir(x, y);
  }

  private async setupWorktree(): Promise<void> {
    const { REPO, WORKTREE_DIR, BRANCH, SETUP_CMD } = this.cfg;
    const branch = `ralph/${this.name}`;
    this.work = WORKTREE_DIR || join(dirname(REPO), `${basename(REPO)}-ralph-${this.name}`);
    const WORK = this.work;
    // There from before a new worktree is made until its SETUP_CMD has passed.
    // A start stopped or killed in between left the worktree and its branch in
    // place, and the next one took the reuse path, which never ran setup: the
    // agent worked for good in a checkout its setup had never finished.
    const pending = this.p(".setup-pending");
    const again = SETUP_CMD !== "" && existsSync(pending);
    let setup = again;
    if (await this.gitOk(["-C", WORK, "rev-parse", "--is-inside-work-tree"], { quiet: true })) {
      // Everything the harness does in WORK resets and cleans it, so WORK has
      // to be this REPO's own worktree and not merely some checkout that
      // happens to sit where WORKTREE_DIR points.
      if (!(await this.sameRepo(WORK, REPO))) {
        await this.refuse(`${WORK} is not a worktree of ${REPO} — refusing to reset a checkout this loop does not own`);
      }
      if (!setup) {
        rmSync(pending, { force: true });
        return;
      }
    } else {
      await this.git(["-C", REPO, "worktree", "prune"]);
      if (await this.gitOk(["-C", REPO, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
        // Reuse the branch as it is. `worktree add -B` would reset it and lose kept work.
        if (!(await this.gitOk(["-C", REPO, "worktree", "add", "-q", WORK, branch], { toLog: true }))) {
          await this.refuse(`cannot create worktree ${WORK}`);
        }
      } else {
        let base = BRANCH;
        if (await this.fetch(["origin", BRANCH], REPO)) base = `origin/${BRANCH}`;
        if (SETUP_CMD) writeFileSync(pending, "");
        if (!(await this.gitOk(["-C", REPO, "worktree", "add", "-q", "-b", branch, WORK, base], { toLog: true }))) {
          rmSync(pending, { force: true });
          await this.refuse(`cannot create worktree ${WORK} from ${base}`);
        }
        setup = SETUP_CMD !== "";
      }
    }
    if (setup) {
      if (again) this.log.line(`SETUP_CMD did not finish the last time ${WORK} was set up, so it runs again`);
      this.log.line(`setup: ${SETUP_CMD}`);
      // In a group of its own, like every command the loop waits on, so a stop
      // ends what the setup started (npm under bash) and not only the shell.
      // Unbounded: it holds no work a gate has yet to judge.
      const r = await this.shell(Infinity, SETUP_CMD, { out: this.log.file, cwd: WORK });
      if (r.rc !== 0) {
        // The branch goes with the worktree. Keeping it sent the next start
        // down the reuse path above, which never runs SETUP_CMD, so the loop
        // ran for good in a worktree its own setup had never prepared.
        await this.git(["-C", REPO, "worktree", "remove", "--force", WORK], { quiet: true });
        await this.git(["-C", REPO, "branch", "-q", "-D", branch], { quiet: true });
        rmSync(pending, { force: true });
        await this.refuse(`SETUP_CMD failed; removed the new worktree and branch ${branch}, so the next start runs setup again`);
      }
    }
    rmSync(pending, { force: true });
    if (!(await this.sameRepo(WORK, REPO))) await this.refuse(`worktree ${WORK} is not usable`);
    this.log.line(`worktree ${WORK} on ${branch}`);
  }

  /** The last HEAD the harness judged. */
  private async markGated(): Promise<void> {
    this.gated(await this.gitOut(["rev-parse", "HEAD"]));
  }

  private gated(sha: string): void {
    writeFileSync(this.p(".gated-head"), `${sha}\n`);
  }

  /**
   * An iteration killed by `ralph stop`, a crash or a reboot can leave commits
   * no gate has seen; at the next start they are set aside instead of being
   * judged by nobody and pushed by the next sync.
   */
  private async dropUnjudged(): Promise<void> {
    const gated = this.p(".gated-head");
    if (!existsSync(gated)) return this.markGated();
    const judged = this.read(gated).trim();
    const head = await this.gitOut(["rev-parse", "HEAD"]);
    if (judged === head) return;
    if (!(await this.gitOk(["cat-file", "-e", `${judged}^{commit}`], { quiet: true }))) return this.markGated();
    await this.saveRef("dropped", head);
    if (!(await this.revertTo(judged))) {
      this.log.line(`cannot reset ralph/${this.name} to the last judged commit ${judged} — fix the worktree by hand`);
      throw new Stop(1);
    }
    record(this.results, this.iter, {
      before: head,
      after: judged,
      status: "drop:interrupted",
      secs: 0,
      reason: `commits from an interrupted iteration were never judged; saved under ${refPrefix(this.name, "dropped")}`,
    });
    this.log.line(
      `start: ${head} was never judged (an iteration was interrupted); reset to ${judged}, saved under ${refPrefix(this.name, "dropped")}`,
    );
  }

  // ------------------------------------------------------------ start

  /**
   * Every refusal a config can earn, before the loop takes ralph.lock: a loop
   * that holds the lock has passed them, which is what `ralph start` waits for.
   * `ralph start` used to wait for the lock and then print "started" for a loop
   * about to refuse its settings. Nothing here may need the lock.
   */
  async check(): Promise<void> {
    const c = this.cfg;
    const file = "config.json";
    if (!c.REPO) await this.refuse(`ralph: ${file} must set REPO`, REFUSED);
    if (!isCheckout(c.REPO)) await this.refuse(`ralph: REPO is not a git checkout: ${c.REPO}`, REFUSED);
    if (c.ACTIVE_HOURS) {
      const w = parseHours(c.ACTIVE_HOURS);
      if (typeof w === "string") await this.refuse(w, REFUSED);
      else this.window = w;
    }
    if (!(c.ACTIVE_POLL >= 1)) c.ACTIVE_POLL = 300;
    // 0 turns QUIET_STOP, ERROR_STOP and CHURN_AT off, so ITER_TIMEOUT 0 reads
    // as no timeout; it was a kill on the spot instead, of every agent before it
    // ran and of every VERIFY_CMD before it judged a commit already paid for. No
    // bound is not on offer either: below 1 is the default, as for every other
    // timeout here, and set before the prompt tells the agent what it is.
    for (const key of ["ITER_TIMEOUT", "VERIFY_TIMEOUT"] as const) {
      if (c[key] >= 1) continue;
      const d = defaults(this.dir)[key];
      this.log.line(`${key} ${c[key]} is not a timeout; using the default ${d}s`);
      c[key] = d;
    }
    // PR_MERGE merges the pull request PUSH="pr" opens from the worktree's
    // branch. Without both there is no such pull request, and a loop that was
    // meant to land its work would quietly leave it wherever it ends up.
    if (c.PR_MERGE && !(c.WORKTREE && c.PUSH === "pr")) {
      await this.refuse(
        `ralph: PR_MERGE merges the pull request that PUSH "pr" opens, so it needs WORKTREE true and PUSH "pr" (this config has WORKTREE ${c.WORKTREE}, PUSH ${JSON.stringify(c.PUSH)})`,
        REFUSED,
      );
    }
    // The frozen-file check stops the loop when git cannot run it, which is
    // after an agent has been paid for; say so before the first one instead.
    if (c.WORKTREE && c.FROZEN.length) {
      const frozen = await this.frozenProblem();
      if (frozen) await this.refuse(`ralph: ${frozen}`, REFUSED);
    }
    // Every iteration would exit 127 and back off, for ever, with no word about why.
    const claude = claudeProblem();
    if (claude) await this.refuse(`ralph: ${claude}`, REFUSED);
    const push = pushProblem(c);
    if (push) {
      await this.refuse(
        `ralph: ${push} — set "PUSH_CONFIRM": ${JSON.stringify(c.BRANCH)} in config.json to mean it, or PUSH "pr" to land through a pull request`,
        REFUSED,
      );
    }
  }

  /**
   * Why the frozen-file check cannot read FROZEN, or "". git judges the
   * entries, with the command the gate runs, against the empty tree, so a
   * repository with no commit yet is asked too. An absolute path names a file
   * in REPO, which git takes here, but the gate runs in the worktree, where the
   * same path is outside the repository and git refuses it.
   */
  private async frozenProblem(): Promise<string> {
    const { REPO, FROZEN } = this.cfg;
    const abs = FROZEN.find((f) => isAbsolute(f));
    if (abs !== undefined) {
      return `FROZEN holds the absolute path ${JSON.stringify(abs)}, and the frozen-file check runs in the worktree, where it names nothing — write it relative to the top of the repository`;
    }
    const empty = (await run(["git", "hash-object", "-t", "tree", "--stdin"], { cwd: REPO, input: "" })).stdout.trim();
    const d = await run(["git", "diff", "--name-only", empty, empty, "--", ...FROZEN], { cwd: REPO });
    if (d.code === 0) return "";
    return `the frozen-file check cannot run, so FROZEN would guard nothing: git diff exited ${d.code}: ${lastNonBlank(splitLines(d.stderr))}`;
  }

  /** What a start does once the lock is this process's: the remote, gh, the worktree. */
  async start(): Promise<void> {
    const c = this.cfg;
    // PUSH with nowhere to push: every sync would fetch, fail and copy git's
    // complaint into the log. Say it once and keep the commits local.
    if (this.harnessPushes() && !(await this.gitOk(["-C", c.REPO, "remote", "get-url", "origin"], { quiet: true }))) {
      this.log.line(`PUSH=${pushWord(c.PUSH)} but ${c.REPO} has no origin remote — keeping commits local, as PUSH=0 does`);
      c.PUSH = false;
    }
    // PUSH=pr opens the pull request through gh. Without a gh that is logged
    // in the branch is still pushed, and the human opens the pull request.
    if (this.harnessPushes() && c.PUSH === "pr") {
      if (await this.ghRun(30, ["auth", "status"])) this.ghOk = true;
      else
        this.log.line(
          `PUSH=pr: gh is missing or not logged in — ralph/${this.name} is still pushed to origin; open its pull request by hand`,
        );
    }
    if (c.LAND_OK_CMD && !(this.harnessPushes() && (c.PUSH === true || c.PR_MERGE))) {
      const pr = this.harnessPushes() && c.PUSH === "pr";
      this.log.line(
        `LAND_OK_CMD: this loop never moves ${c.BRANCH} itself (PUSH=${pushWord(c.PUSH)}${pr ? " without PR_MERGE" : ""}), so the check holds nothing${pr ? "; the pull request asks whoever merges it to run the check first" : ""}`,
      );
    }

    if (c.WORKTREE) await this.setupWorktree();
    try {
      process.chdir(this.work);
    } catch {
      await this.refuse(`cannot enter the work directory ${this.work}`);
    }
    if (c.WORKTREE) await this.dropUnjudged();

    if (c.LIVE_STEER) {
      writeFileSync(this.p(".agent-settings.json"), `${JSON.stringify(agentSettings())}\n`);
    }
    if (c.PLAN_FIRST) {
      writeFileSync(this.p(".plan-mcp.json"), `${JSON.stringify(planMcpConfig(this.dir))}\n`);
    }

    this.log.line(
      `ralph start: loop=${this.name} repo=${c.REPO} work=${this.work} model=${c.MODEL} max_iter=${c.MAX_ITER} quiet_stop=${c.QUIET_STOP} worktree=${c.WORKTREE ? 1 : 0} push=${pushWord(c.PUSH)} review=${c.REVIEW ? 1 : 0} verify=${c.VERIFY_CMD ? "yes" : ""} health=${c.HEALTH_CMD ? "yes" : ""} churn_at=${c.CHURN_AT} limit_reset=${c.LIMIT_RESET ? 1 : 0} plan_first=${c.PLAN_FIRST ? 1 : 0} land_ok=${c.LAND_OK_CMD ? "yes" : ""}`,
    );
  }

  // ------------------------------------------------------------ the loop

  async run(): Promise<void> {
    const c = this.cfg;
    // What the loop was already being asked before it started is not news.
    const seen = decisions(this.read(this.p("PROGRESS.md")));
    writeFileSync(this.p(".decision-seen"), seen.map((l) => `${l}\n`).join(""));

    for (;;) {
      // Before the window: a loop whose last iteration ended as the window
      // closed has nothing left to wait for.
      if (this.iter >= c.MAX_ITER) {
        this.stop(`hit MAX_ITER=${c.MAX_ITER}`);
        break;
      }
      await this.waitForActiveHours();
      this.iter++;
      // Half a prompt is not a prompt, and an agent handed one under
      // --dangerously-skip-permissions does something with it.
      const gone = this.missing("PROMPT.md", "PROGRESS.md");
      if (gone) {
        this.iter--;
        this.stop(
          `${gone} is gone or unreadable at ${this.p(gone)} — every iteration re-reads it, and the harness will not run an agent without it`,
          true,
        );
        break;
      }
      if (!(await this.iteration())) break;
    }

    // While the pid file is still there: `ralph status` shows a loop waiting on
    // its pull request's checks as running.
    if (!this.broken) {
      this.ended = true;
      await this.prReady();
      await this.mergeAtEnd();
    }
    rmSync(this.p("ralph.pid"), { force: true });
    this.log.line(`ralph finished after ${this.iter} iterations`);
    // The one stop notification, for every way the loop can end. Not for a
    // signal: `ralph stop` and a reboot are the human's own doing.
    await this.notify("stopped", `${this.stopWhy || "the loop ended"} (after ${this.iter} iterations)`);
  }

  /**
   * Why the loop ended: logged and remembered for the one notification, in the
   * same words. `broken` when the loop stops because something is wrong with
   * its own state, not because its job or a limit said so; PR_MERGE does not
   * merge from a loop in that condition.
   */
  private stop(why: string, broken = false): void {
    this.stopWhy = why;
    this.broken = broken;
    this.log.line(`stopping: ${why}`);
  }

  /** One iteration; false when the loop should stop. */
  private async iteration(): Promise<boolean> {
    const c = this.cfg;
    this.log.rotate(c.LOG_MAX_BYTES, c.LOG_KEEP);
    if (c.WORKTREE) {
      // Before the agent too: it would work, and be judged, on top of what
      // the last one left.
      const unclean = await this.cleanTree();
      if (unclean) {
        this.stop(`could not clean the worktree before iteration ${this.iter} (${unclean}) — fix it by hand`, true);
        this.iter--;
        return false;
      }
      if (this.harnessPushes()) await this.sync();
    }
    // The same text already sits in PROMPT.md's Steering section, which this
    // iteration reads; the live file is only for the iteration in flight.
    if (c.LIVE_STEER) {
      writeFileSync(this.p("STEER.md"), "");
      writeFileSync(this.p("STEER.md.delivered"), "");
    }

    // After the sync, so it judges what is about to be worked on, and before
    // DONE_CMD, because a job is not done while the system it runs is broken.
    const healthy = await this.health();
    if (c.DONE_CMD && !healthy) {
      this.log.line("DONE_CMD not asked: HEALTH_CMD is failing");
    } else if (c.DONE_CMD && (await this.done())) {
      return false;
    }

    const before = await this.gitOut(["rev-parse", "HEAD"]);
    if (c.WORKTREE) await this.markGated();
    const started = nowSec();
    this.log.line(`=== iteration ${this.iter} (HEAD ${before}) ===`);

    await this.churnScan();
    // PROMPT.md is re-read every iteration, so editing it (or `ralph steer`)
    // redirects the loop without restarting it.
    await this.buildPrompt();

    const args = agentArgs(c, this.dir);
    const env: Record<string, string> = { RALPH_STEER_FILE: this.p("STEER.md") };
    if (this.harnessPushes()) {
      // The agent's own push to this repository fails; only the harness
      // pushes. Keyed on the URL, not on the remote's name: git applies a
      // setting from the environment to every repository the process touches,
      // so naming the remote would also break a push to an unrelated `origin`.
      const pushUrl = await this.gitOut(["remote", "get-url", "--push", "origin"], { quiet: true });
      if (pushUrl) {
        env.GIT_CONFIG_COUNT = "1";
        env.GIT_CONFIG_KEY_0 = "url.no-push://disabled.pushInsteadOf";
        env.GIT_CONFIG_VALUE_0 = pushUrl;
      }
    }

    const offset = this.log.size();
    // stdout is JSON; stderr goes to the log as it happens, and the text is
    // appended after it, so the log reads as it always did and a limit's
    // message is among the last lines the limit check reads.
    const runJson = this.p(".run.json");
    writeFileSync(runJson, "");
    if (c.PLAN_FIRST) writeFileSync(this.p(".plan.md"), "");
    const agent = await this.bounded(c.ITER_TIMEOUT, ["claude", ...args], {
      stdin: this.promptFile,
      out: runJson,
      err: this.log.file,
      env,
    });
    const agentOut = claudeText(this.read(runJson));
    if (c.PLAN_FIRST) {
      const plan = this.read(this.p(".plan.md"));
      if (plan.trim()) {
        this.log.line("plan approved:");
        this.log.raw(plan.endsWith("\n") ? plan : `${plan}\n`);
      } else {
        this.log.line("no plan was approved: the agent never called ExitPlanMode");
      }
    }
    this.log.raw(agentOut.text);
    let reviewCost = "-";
    let reviewTokens = "-";

    let status = "";
    let reason = "";
    let unchecked = "";
    if (c.WORKTREE) {
      // Gates judge what was committed. Anything left uncommitted is thrown
      // away first, so an uncommitted edit to a frozen file cannot help a
      // commit pass, and a tree that could not be cleaned is not judged.
      const unclean = await this.cleanTree();
      const branch = await this.gitOut(["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true });
      // History first: a deleted branch leaves no HEAD to reset to, and that
      // is the agent leaving the branch, not a tree git could not write.
      if (branch !== `ralph/${this.name}` || !(await this.gitOk(["merge-base", "--is-ancestor", before, "HEAD"], { quiet: true }))) {
        status = "revert:history";
        reason = `the agent left ralph/${this.name} or rewrote its history`;
      } else if (unclean) {
        status = "revert:unclean";
        reason = `could not clean the worktree: ${unclean}`;
      }
    }
    const after = await this.gitOut(["rev-parse", "HEAD"]);
    const took = nowSec() - started;

    if (!status && before === after) {
      if (agent.timedOut) {
        status = "timeout";
        reason = `killed after ${c.ITER_TIMEOUT}s`;
      } else if (agent.rc !== 0) {
        const last = tailLines(this.logSince(offset), 20);
        const hit = limitLine(last, this.limitRe);
        if (hit !== null) {
          status = "ratelimit";
          reason = hit;
        } else {
          status = "error";
          reason = `claude exited ${agent.rc}: ${lastNonBlank(last)}`;
        }
      } else {
        status = "quiet";
      }
    } else if (!status && c.WORKTREE) {
      // A check git could not run is not a pass. git refuses a pathspec it
      // cannot read with nothing on stdout, and reading stdout alone kept every
      // commit, the ones that edited a frozen file too.
      let touched = "";
      if (c.FROZEN.length) {
        const d = await run(["git", "diff", "--name-only", before, "HEAD", "--", ...c.FROZEN]);
        if (d.code !== 0) unchecked = `git diff exited ${d.code}: ${lastNonBlank(splitLines(d.stderr))}`;
        else
          touched = splitLines(d.stdout)
            .map((f) => `${f} `)
            .join("");
      }
      const v = touched || unchecked ? null : await this.verify();
      if (unchecked) {
        status = "revert:frozen";
        reason = `could not check the frozen files: ${unchecked}`;
      } else if (touched) {
        status = "revert:frozen";
        reason = `touched frozen files: ${touched}`;
      } else if (v !== null) {
        status = "revert:verify";
        reason = v;
      } else if (c.REVIEW) {
        const r = await this.review(before);
        reviewCost = r.cost;
        reviewTokens = r.tokens;
        if (r.status === "accept") status = "keep";
        else if (r.status === "reject") {
          status = "revert:review";
          reason = r.reason;
        } else if (c.VERIFY_CMD) {
          status = "keep:unreviewed";
          reason = `${r.reason}; VERIFY_CMD passed`;
        } else {
          // With no VERIFY_CMD the reviewer is the only gate; do not ship unjudged work.
          status = "revert:review-unavailable";
          reason = r.reason;
        }
      }
    }
    if (!status) status = "keep";
    if (agent.timedOut && status.split(":")[0] !== "timeout") {
      reason = `${reason ? `${reason}; ` : ""}agent timed out after ${c.ITER_TIMEOUT}s`;
    }
    const cost = addCost(agentOut.cost, reviewCost);
    const tokens = addTokens(agentOut.tokens, reviewTokens);
    // Read now: a sync before the next iteration can run VERIFY_CMD again and
    // overwrite verify.out. Kept through an iteration that judged nothing (a
    // limit, a crash), so the retry still hears about it.
    if (status === "revert:verify") this.verifyFailed = { before, after, tail: this.lastLines(this.p("verify.out")) };
    else if (!["ratelimit", "timeout", "error"].includes(status)) this.verifyFailed = null;

    if (status.startsWith("revert:")) {
      await this.saveRef("reverted", after);
      if (!(await this.revertTo(before))) {
        record(this.results, this.iter, { before, after, status, secs: took, reason, cost, tokens });
        this.stop(`could not reset ralph/${this.name} to ${before} after ${status} — fix the worktree by hand`, true);
        return false;
      }
    }
    record(this.results, this.iter, { before, after, status, secs: took, reason, cost, tokens });
    // Judged, and remembered as judged in the same tick as the row, before
    // anything below awaits. A stop during the notifications once left
    // .gated-head at `before`, and the next start set aside a commit its own
    // keep row called kept, as never judged, and the log never said shipped.
    if (status.startsWith("keep")) {
      if (c.WORKTREE) this.gated(after);
      this.log.line(`iteration ${this.iter} shipped ${after} in ${took}s${reason ? ` (${reason})` : ""}`);
    }
    if (unchecked) {
      // It fails the same way next time, and every agent after this one would
      // be paid for and then reset.
      this.stop(`the frozen-file check could not run (${unchecked}); reset to ${before} — fix FROZEN in config.json`, true);
      return false;
    }

    // A limit streak clears the moment claude answers again, whatever the
    // verdict of that iteration is. Said once, at the end of the streak.
    if (status !== "ratelimit" && this.limits > 0) {
      await this.notify("limit-clear", `claude answered again after ${this.limits} iteration(s) waiting out a limit`);
      this.limits = 0;
    }
    // Before the naps below: a human hears about a question now.
    await this.checkDecisions();

    if (status.startsWith("keep")) {
      this.quiet = 0;
      this.trouble = 0;
      this.errors = 0;
      if (this.harnessPushes()) await this.sync();
    } else if (status === "quiet") {
      this.quiet++;
      this.trouble = 0;
      this.errors = 0;
      this.log.line(`iteration ${this.iter} shipped nothing in ${took}s (quiet streak ${this.quiet})`);
      if (c.QUIET_STOP > 0 && this.quiet >= c.QUIET_STOP) {
        this.stop(`${c.QUIET_STOP} consecutive iterations shipped nothing`);
        return false;
      }
      await this.pause(c.QUIET_SLEEP);
    } else if (status === "ratelimit") {
      this.limits++;
      const reset: Reset | null = c.LIMIT_RESET ? resetAt(reason, nowSec()) : null;
      if (reset) {
        this.log.line(`iteration ${this.iter} hit a limit: ${reason} — it resets at ${reset.at}, waiting until then`);
        // The first of the streak only: a loop can wait out a weekly limit over
        // dozens of iterations, and a human needs to hear that once.
        if (this.limits === 1) await this.notify("limit", `${reason} — waiting until ${reset.at}`);
      } else {
        this.log.line(`iteration ${this.iter} hit a limit: ${reason} — trying it again in ${c.RATE_LIMIT_SLEEP}s`);
        if (this.limits === 1) await this.notify("limit", reason);
      }
      // Waiting out a limit is not work, so it does not use up MAX_ITER.
      this.iter--;
      if (reset) await this.waitUntil(reset.epoch);
      else await nap(c.RATE_LIMIT_SLEEP);
    } else if (status === "timeout" || status === "error") {
      this.trouble++;
      this.errors++;
      this.log.line(`iteration ${this.iter} ${status}: ${reason} (errors in a row ${this.errors})`);
      await this.streakNotice(status, reason);
      if (c.ERROR_STOP > 0 && this.errors >= c.ERROR_STOP) {
        this.stop(`${c.ERROR_STOP} consecutive iterations failed`);
        return false;
      }
      await this.pause(this.troubleSleep());
    } else if (status.startsWith("revert:")) {
      this.trouble++;
      this.errors = 0;
      this.log.line(`iteration ${this.iter} reverted to ${before}: ${status} — ${reason}`);
      await this.streakNotice(status, reason);
      await this.pause(this.troubleSleep());
    }

    this.capProgress();
    await this.pause(c.STEP_SLEEP);
    return true;
  }

  /** The log from byte `offset` on: what this iteration's agent said. */
  private logSince(offset: number): string {
    try {
      return readFileSync(this.log.file).subarray(offset).toString("utf8");
    } catch {
      return "";
    }
  }

  /** DONE_CMD: true when it says the job is done, and the stop is recorded. */
  private async done(): Promise<boolean> {
    const c = this.cfg;
    const out = this.p("done.out");
    writeFileSync(out, "");
    const r = await this.shell(300, c.DONE_CMD, {
      out,
      env: { RALPH_DIR: this.dir, RALPH_LOOP: this.name },
    });
    if (r.rc !== 0 || r.timedOut) return false;
    this.iter--; // this one never ran; do not count it
    let unpushed = 0;
    if (c.WORKTREE && c.PUSH === true) {
      unpushed = Number(await this.gitOut(["rev-list", "--count", `origin/${c.BRANCH}..HEAD`], { quiet: true })) || 0;
    } else if (c.WORKTREE && c.PUSH === "pr") {
      let pushed = `refs/remotes/origin/ralph/${this.name}`;
      if (!(await this.gitOk(["rev-parse", "-q", "--verify", pushed], { quiet: true }))) pushed = `origin/${c.BRANCH}`;
      unpushed = Number(await this.gitOut(["rev-list", "--count", `${pushed}..HEAD`], { quiet: true })) || 0;
    }
    this.stop(`DONE_CMD says the job is done${unpushed > 0 ? ` — ${unpushed} kept commits are still not pushed` : ""}`);
    return true;
  }

  // ------------------------------------------------------------ waiting

  /** Before an iteration, never during one. The wait does not count toward MAX_ITER. */
  private async waitForActiveHours(): Promise<void> {
    if (inWindow(this.window, hour())) return;
    this.log.line(`outside ACTIVE_HOURS=${this.cfg.ACTIVE_HOURS} — waiting for the window to open`);
    while (!inWindow(this.window, hour())) await nap(this.cfg.ACTIVE_POLL);
    this.log.line(`inside ACTIVE_HOURS=${this.cfg.ACTIVE_HOURS} — going on`);
  }

  /**
   * Nap until the clock reads `epoch`, at most ACTIVE_POLL seconds at a time,
   * so a machine that slept through part of the wait wakes to the right answer.
   */
  private async waitUntil(epoch: number): Promise<void> {
    for (;;) {
      let left = epoch - nowSec();
      if (left <= 0) return;
      if (left > this.cfg.ACTIVE_POLL) left = this.cfg.ACTIVE_POLL;
      await nap(left);
    }
  }

  /**
   * The pause between this iteration and the next. After the last there is no
   * next, so nothing to space out: the loop ends at once, and PR_MERGE does not
   * wait behind a backoff. A limit is not this: it gives back its iteration
   * (`iter--`), so its wait comes before one that will run.
   */
  private async pause(s: number): Promise<void> {
    if (this.iter >= this.cfg.MAX_ITER) return;
    await nap(s);
  }

  /** Consecutive failures double the pause, up to an hour. */
  private troubleSleep(): number {
    let s = this.cfg.ERROR_SLEEP;
    for (let i = 1; i < this.trouble && s < 3600; i++) s *= 2;
    return s > 3600 ? 3600 : s;
  }

  /**
   * The streak the prompt escalates on, told to the human as it is reached and
   * not again: from here the prompt is already telling the agent to pivot.
   */
  private async streakNotice(status: string, reason: string): Promise<void> {
    const n = this.cfg.ESCALATE_AFTER;
    if (!(n > 0) || this.trouble !== n) return;
    await this.notify(
      "stuck",
      `${this.trouble} iterations in a row were reverted or failed; the last: ${status} — ${reason || "no reason recorded"}`,
    );
  }

  // ------------------------------------------------------------ memory

  /**
   * The "Needs a decision" section is how the agent hands a blocker back.
   * Notified once per new line: an agent rewrites PROGRESS.md whole every
   * iteration, so a question settled, reworded or moved changes the section
   * without asking anything new.
   */
  private async checkDecisions(): Promise<void> {
    const file = this.p("PROGRESS.md");
    if (!existsSync(file)) return;
    const now = decisions(this.read(file));
    const seenFile = this.p(".decision-seen");
    const seen = existsSync(seenFile) ? new Set(splitLines(this.read(seenFile))) : null;
    const added = seen ? now.filter((l) => !seen.has(l)) : now;
    writeFileSync(seenFile, now.map((l) => `${l}\n`).join(""));
    if (!added.length) return;
    this.log.line('PROGRESS.md has a new question under "Needs a decision" — the agent is asking a human');
    await this.notify("decision", headBytes(added.join("\n"), 1000));
  }

  /** Keep PROGRESS.md at its head sections plus the newest PROGRESS_KEEP Log entries. */
  private capProgress(): void {
    const keep = this.cfg.PROGRESS_KEEP;
    if (!(keep > 0)) return;
    const file = this.p("PROGRESS.md");
    if (!existsSync(file)) return;
    const r = capProgress(this.read(file), keep);
    if (r.entries === 0) {
      // Said whether or not the '## Log' heading is there: either way the
      // entry cap is doing nothing and PROGRESS_MAX_BYTES is the only bound.
      if (!this.capWarned) {
        this.log.line(
          "progress cap: no '### ' entries under a '## Log' heading in PROGRESS.md, so the entry cap does nothing; the prompt is bounded by PROGRESS_MAX_BYTES alone",
        );
      }
      this.capWarned = true;
      return;
    }
    if (r.kept === null) return;
    const archive = this.p("PROGRESS-archive.md");
    if (!existsSync(archive)) writeFileSync(archive, ARCHIVE_HEADER);
    writeFileSync(archive, this.read(archive) + r.archived);
    rewrite(file, r.kept);
    this.log.line(`progress cap: moved ${r.entries - keep} old Log entries to PROGRESS-archive.md`);
  }

  // ------------------------------------------------------------ health and churn

  /**
   * HEALTH_CMD, before every iteration: a check of the running system. While it
   * fails, its output leads the prompt, DONE_CMD is not asked, and a human hears
   * about it once on the way down and once on the way up. HEAD is remembered
   * whenever it passes, in a file so a restart keeps it: the commits since are
   * the first suspects.
   */
  private async health(): Promise<boolean> {
    const c = this.cfg;
    if (!c.HEALTH_CMD) return true;
    const secs = c.HEALTH_TIMEOUT >= 1 ? c.HEALTH_TIMEOUT : 300;
    const out = this.p("health.out");
    writeFileSync(out, "");
    const r = await this.shell(secs, c.HEALTH_CMD, {
      out,
      env: { RALPH_DIR: this.dir, RALPH_LOOP: this.name },
    });
    this.log.raw(this.read(out));
    if (!r.timedOut && r.rc === 0) {
      writeFileSync(this.p(".health-ok"), `${await this.gitOut(["rev-parse", "HEAD"], { quiet: true })}\n`);
      if (this.healthState === "fail") {
        this.log.line("health: HEALTH_CMD passes again");
        await this.notify("health-clear", `HEALTH_CMD passes again; it had failed since ${this.healthSince}`);
      }
      this.healthState = "ok";
      this.healthSince = "";
      return true;
    }
    this.healthWhy = r.timedOut ? `timed out after ${secs}s` : `exited ${r.rc}`;
    if (this.healthState !== "fail") {
      this.healthSince = stampMinutes();
      this.log.line(`health: HEALTH_CMD ${this.healthWhy} — every prompt leads with it until it passes`);
      await this.notify("health", `HEALTH_CMD ${this.healthWhy}: ${[...lastNonBlank(splitLines(this.read(out)))].slice(0, 300).join("")}`);
    }
    this.healthState = "fail";
    return false;
  }

  /** The last 40 lines of a command's output, at most its last 4000 bytes, without escape codes: what a prompt can carry. */
  private lastLines(file: string): string {
    const tail = tailLines(stripEscapes(this.read(file)), 40)
      .map((l) => `${l}\n`)
      .join("");
    return chomp(
      Buffer.from(tail)
        .subarray(Math.max(0, Buffer.byteLength(tail) - 4000))
        .toString("utf8"),
    );
  }

  /**
   * LAND_OK_CMD, before the harness moves BRANCH — a push with PUSH true, the
   * merge with PR_MERGE: true when BRANCH may move now. Otherwise the caller
   * waits and asks again, for as long as it takes. The work it holds has passed
   * every gate, so an unbounded wait costs nothing but time, and a deploy that
   * cuts off a long job in production costs more. A human hears once per wait.
   */
  private async landHeld(what: string): Promise<boolean> {
    const c = this.cfg;
    if (!c.LAND_OK_CMD) return false;
    const secs = c.LAND_OK_TIMEOUT >= 1 ? c.LAND_OK_TIMEOUT : 300;
    const out = this.p("land.out");
    writeFileSync(out, "");
    const r = await this.shell(secs, c.LAND_OK_CMD, {
      out,
      env: { RALPH_DIR: this.dir, RALPH_LOOP: this.name },
    });
    this.log.raw(this.read(out));
    if (!r.timedOut && r.rc === 0) {
      if (this.landWaiting) this.log.line(`land: LAND_OK_CMD passes; going on with ${what}`);
      this.landWaiting = false;
      return false;
    }
    const why = r.timedOut ? `timed out after ${secs}s` : `exited ${r.rc}`;
    if (!this.landWaiting) {
      this.landWaiting = true;
      this.log.line(`land: LAND_OK_CMD ${why} — holding ${what}, asking again every ${c.ACTIVE_POLL}s`);
      const said = [...lastNonBlank(splitLines(this.read(out)))].slice(0, 300).join("");
      await this.notify("land-held", `holding ${what}: LAND_OK_CMD ${why}${said ? `: ${said}` : ""}`);
    }
    await nap(c.ACTIVE_POLL);
    return true;
  }

  private async healthSection(): Promise<string> {
    if (this.healthState !== "fail") return "";
    let s = "\n---\n\n# Harness: the health check is failing — this comes first\n\n";
    s += `HEALTH_CMD, the human's own check of the running system, ${this.healthWhy}, and has failed since ${this.healthSince}.\n`;
    const ok = this.read(this.p(".health-ok")).trim();
    if (ok && (await this.gitOk(["cat-file", "-e", `${ok}^{commit}`], { quiet: true }))) {
      const suspects = splitLines(await this.gitOut(["log", "--format=%h %s", `${ok}..HEAD`], { quiet: true }))
        .map((l) => [...l].slice(0, 200).join(""))
        .slice(0, 10)
        .join("\n");
      if (suspects) s += `\nCommits since it last passed, the first suspects:\n\n${suspects}\n`;
      else s += "\nNo commit has landed since it last passed, so the cause is outside this branch.\n";
    }
    s += `\nIts last lines:\n\n\`\`\`\n${this.lastLines(this.p("health.out"))}\n\`\`\`\n`;
    s +=
      '\nFind and fix the cause before any other work. If commits of this loop caused it, fix or revert them. If the cause is outside the code (an outage, a credential, a third party), write it under "Needs a decision" in PROGRESS.md and change nothing.\n';
    return s;
  }

  /**
   * The files that at least CHURN_AT of the last CHURN_WINDOW kept iterations
   * changed, from git and the keep rows — ground truth, not what the agents
   * wrote about themselves. A human hears about a file the first time it turns
   * up, not every iteration it stays.
   */
  private async churnScan(): Promise<void> {
    const c = this.cfg;
    this.churnText = [];
    this.churnKept = 0;
    if (!(c.CHURN_AT > 0) || !existsSync(this.results)) return;
    const win = c.CHURN_WINDOW >= 1 ? c.CHURN_WINDOW : 8;
    const keeps = keepRows(readResults(this.results).rows);
    const rows = keeps.slice(Math.max(0, keeps.length - win));
    this.churnKept = rows.length;
    const counts = new Map<string, number>();
    const exclude = c.CHURN_IGNORE.map((p) => `:(exclude)${p}`);
    for (const [b, a] of rows) {
      const files = new Set(splitLines(await this.gitOut(["diff", "--name-only", b, a, "--", ".", ...exclude], { quiet: true })));
      for (const f of files) counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    this.churnText = [...counts.entries()]
      .filter(([, n]) => n >= c.CHURN_AT)
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      .slice(0, 10)
      .map(([f, n]) => [n, f]);
    const files = this.churnText.map(([, f]) => f);
    const seenFile = this.p(".churn-seen");
    const seenText = this.read(seenFile);
    const seen = seenText !== "" ? new Set(splitLines(seenText)) : null;
    const added = seen ? files.filter((f) => !seen.has(f)) : files;
    writeFileSync(seenFile, files.map((f) => `${f}\n`).join(""));
    if (!added.length) return;
    const list = added.join(", ");
    this.log.line(`churn: ${list} changed in at least ${c.CHURN_AT} of the last ${this.churnKept} kept iterations`);
    await this.notify("churn", `${list} changed in at least ${c.CHURN_AT} of the last ${this.churnKept} kept iterations of this loop`);
  }

  private churnSection(): string {
    if (!this.churnText.length) return "";
    let s = "\n---\n\n# Harness: the same files keep changing\n\n";
    s += `Counted from git over the last ${this.churnKept} kept iterations of this loop:\n\n`;
    s += this.churnText.map(([n, f]) => `- ${f}, changed in ${n} of them\n`).join("");
    s +=
      '\nFix after fix in one place usually means each fix closes the gap the last one left. Before you touch these again, name the class of defect and close it in one commit, with a test that covers the whole class; or write under "Needs a decision" in PROGRESS.md why it keeps breaking, and take work elsewhere.\n';
    return s;
  }

  // ------------------------------------------------------------ the prompt

  /**
   * The agent is told to leave the full VERIFY_CMD to the harness, so a failure
   * has to cost it less than a lost iteration: the output, and the commits the
   * gate reset, which saveRef keeps reachable.
   */
  private verifySection(): string {
    const f = this.verifyFailed;
    if (!f) return "";
    let s = "\n---\n\n# Harness: VERIFY_CMD failed on the last commits\n\n";
    s += `The harness ran \`${this.cfg.VERIFY_CMD}\` on them and reset them. Its last lines:\n\n\`\`\`\n${f.tail}\n\`\`\`\n`;
    s += `\nThe commits are kept: \`git cherry-pick ${f.before}..${f.after}\` brings them back, to fix what failed rather than write them again.\n`;
    return s;
  }

  /**
   * The commits this loop kept, newest first, as git has them. Built from the
   * keep rows, not from `git log`, which on a shared branch also shows commits
   * by people and other loops. Subjects are cut, so the prompt stays bounded.
   */
  private async shippedRecently(): Promise<string> {
    if (!existsSync(this.results)) return "";
    const keeps = keepRows(readResults(this.results).rows);
    const recent = keeps.slice(Math.max(0, keeps.length - 5)).reverse();
    const lines: string[] = [];
    for (const [b, a] of recent) {
      for (const l of splitLines(await this.gitOut(["log", "--format=%h %s", `${b}..${a}`], { quiet: true }))) {
        lines.push([...l].slice(0, 200).join(""));
      }
    }
    const shown = lines.slice(0, 10).join("\n");
    return shown ? `\n---\n\n# What this loop shipped recently (from git, newest first)\n\n${shown}\n` : "";
  }

  private async buildPrompt(): Promise<void> {
    const c = this.cfg;
    let s = this.read(this.p("PROMPT.md"));
    s += await this.healthSection();
    s += "\n---\n\n# PROGRESS.md (your memory of previous iterations — read this before doing anything)\n\n";
    const progressFile = this.p("PROGRESS.md");
    const injected = injectProgress(this.read(progressFile), c.PROGRESS_MAX_BYTES, progressFile);
    s += injected.text;
    const archive = this.p("PROGRESS-archive.md");
    if (this.read(archive) !== "") s += `\nOlder Log entries are in ${archive}. Read it only when you need that history.\n`;

    if (existsSync(this.results)) {
      const { header, rows } = readResults(this.results);
      s += "\n---\n\n# Harness verdicts (ground truth: where PROGRESS.md disagrees, this wins)\n\n";
      s += 'The last iterations as the harness recorded them. "revert:*" means the commits were reset and never shipped.\n\n';
      s += `${header.split("\t").slice(0, 7).join("\t")}\n`;
      for (const r of rows.slice(Math.max(0, rows.length - 10))) s += `${r.slice(0, 7).join("\t")}\n`;
    }
    s += await this.shippedRecently();
    s += this.churnSection();
    s += this.verifySection();

    if (c.WORKTREE) {
      s += "\n---\n\n# Where you work\n\n";
      s += `Your working copy is ${this.work}, on branch ralph/${this.name}. Never touch ${c.REPO}.\n`;
      if (c.PUSH === true) {
        s +=
          "Commit your work, but do not push: the harness checks each commit and pushes the ones it keeps. A rejected commit is reset, and the verdict shows up above next time.\n";
      } else if (c.PUSH === "pr") {
        const merges = c.PR_MERGE
          ? `and merges its pull request into ${c.BRANCH} when the loop ends, if every check on it passes`
          : `and a human merges its pull request into ${c.BRANCH}`;
        s += `Commit your work, but do not push: the harness checks each commit, pushes the ones it keeps to ralph/${this.name}, ${merges}. A rejected commit is reset, and the verdict shows up above next time.\n`;
      } else {
        s += `Commit your work, but do not push. A human merges ralph/${this.name}.\n`;
      }
      if (c.VERIFY_CMD) {
        s += `\nAfter your turn the harness runs VERIFY_CMD on your commits — \`${c.VERIFY_CMD}\`, for up to ${c.VERIFY_TIMEOUT}s — and resets them if it fails. It runs whatever you did, so do not run the whole of it yourself: run the tests that cover what you changed, and leave the full run to the harness.\n`;
      }
    }
    if (c.FROZEN.length) s += `\nFrozen, never edit: ${c.FROZEN.join(" ")}. A commit that touches any of them is reset.\n`;

    const e = c.ESCALATE_AFTER;
    if (e > 0 && this.trouble >= e * 2) {
      s += `\n---\n\n# Harness: stuck\n\nThe last ${this.trouble} iterations were reverted or failed (see the verdicts). Stop attacking this. Write the blocker under "Needs a decision" in PROGRESS.md, with what was tried, then take unrelated work. If there is none, change nothing.\n`;
    } else if (e > 0 && this.trouble >= e) {
      s += `\n---\n\n# Harness: stuck\n\nThe last ${this.trouble} iterations were reverted or failed (see the verdicts). Do not retry that approach. Pivot to a different defect or a different method.\n`;
    }
    if (c.PLAN_FIRST) {
      s +=
        "\n---\n\n# Plan first\n\nYou start in plan mode. Read what you need and plan this one iteration, then call ExitPlanMode. The harness approves the plan at once and you carry it out in this same session, without prompts.\n";
    }
    s += `\n---\n\n${c.CLOSING}\n`;
    writeFileSync(this.promptFile, s);
    if (injected.cut !== null && !this.injectWarned) {
      this.log.line(
        `progress cap: PROGRESS.md is ${injected.cut} bytes, over PROGRESS_MAX_BYTES=${c.PROGRESS_MAX_BYTES} — injecting its first ${c.PROGRESS_MAX_BYTES} bytes and leaving the file alone`,
      );
    }
    if (injected.cut !== null) this.injectWarned = true;
  }

  // ------------------------------------------------------------ the gates

  /** VERIFY_CMD: null when it passes, else why it did not. */
  private async verify(): Promise<string | null> {
    const c = this.cfg;
    if (!c.VERIFY_CMD) return null;
    const out = this.p("verify.out");
    writeFileSync(out, "");
    const r = await this.shell(c.VERIFY_TIMEOUT, c.VERIFY_CMD, { out });
    const text = this.read(out);
    this.log.raw(text);
    if (r.timedOut) return `verify timed out after ${c.VERIFY_TIMEOUT}s`;
    if (r.rc !== 0) return `verify exited ${r.rc}: ${lastNonBlank(splitLines(text))}`;
    return null;
  }

  /** A fresh, read-only claude judges the new commits since `before`. */
  private async review(before: string): Promise<Review> {
    const c = this.cfg;
    let cost = "-";
    let tokens = "-";
    // A job the harness cannot read is not a job. Asked with an empty brief the
    // reviewer still answers, and its ACCEPT is worth nothing, so hand it to
    // the unavailable path before spending the call.
    const gone = this.missing("PROMPT.md");
    if (gone) return { status: "unavailable", reason: `${gone} is gone, so there is no job to review against`, cost, tokens };

    // The messages first, so the cap cannot cut them: they are where a commit
    // claims what it measured, and the reviewer cannot reach git itself — in a
    // worktree .git is a file pointing into a repository outside its reach.
    const shown = [
      await this.git(["log", "--reverse", "--format=commit %H%n%n%B", `${before}..HEAD`]),
      await this.git(["diff", "--stat", before, "HEAD"]),
      await this.git(["diff", before, "HEAD"]),
    ];
    // git that cannot show the commits prints nothing, and a reviewer handed
    // nothing still answers: its ACCEPT is of an empty diff.
    const failed = shown.find((r) => r.code !== 0);
    if (failed) {
      return {
        status: "unavailable",
        reason: `git could not show the commits (exit ${failed.code}), so there was nothing to review`,
        cost,
        tokens,
      };
    }
    const [messages, stat, diff] = shown.map((r) => r.stdout);
    writeFileSync(this.p("review.diff"), Buffer.from(`${messages}\n${stat}\n${diff}`).subarray(0, 200000));
    const prompt = this.read(this.p("PROMPT.md"));
    // A PROMPT.md written without that heading is still the job. Better the
    // reviewer reads all of it than judges the diff against nothing.
    const job = section(prompt, "## The job") || chomp(prompt);
    let steering = section(prompt, "## Steering");
    const doneLike = section(prompt, "## Done looks like");
    let doneBlock = "";
    if (/\S/.test(doneLike) && !/^\s*<.*>\s*$/.test(doneLike.split("\n").join(""))) {
      doneBlock = `\n## What done looks like (from the human)\n\n${doneLike}\n\nHold the commit against this, as one step toward it. Reject a commit that\ncontradicts it, or one that claims the job is done while this is not met. A step\nthat is merely not the finished result yet is not a reason to reject.\n`;
    }
    let churnBlock = "";
    if (this.churnText.length) {
      const inDiff = new Set(splitLines(await this.gitOut(["diff", "--name-only", before, "HEAD"], { quiet: true })));
      const hot = this.churnText
        .filter(([, f]) => inDiff.has(f))
        .map(([n, f]) => `- ${f}, changed in ${n} of the last ${this.churnKept} kept iterations`)
        .join("\n");
      if (hot) {
        churnBlock = `\n## Files this loop keeps changing\n\nThis commit changes files that earlier kept commits of this loop changed again\nand again (counted from git):\n\n${hot}\n\nHold it to a higher bar. Reject one more fix for one more instance of a gap an\nearlier commit in the same place left open, unless the commit says why the\nearlier fixes missed it and closes the whole class, with a test for the class.\nAccept a commit that does close the class.\n`;
      }
    }
    const checked: string[] = [];
    if (c.FROZEN.length) checked.push(`- None of the frozen files changed: ${c.FROZEN.join(" ")}.`);
    if (c.VERIFY_CMD) {
      checked.push(
        `- VERIFY_CMD passed on these commits: \`${c.VERIFY_CMD}\`. Its output is in ${this.p("verify.out")}.`,
        "",
        "You cannot run commands, and you do not need to: that the tests pass is settled.",
        "Do not reject for not having run them. Judge what that check cannot see.",
      );
    } else {
      checked.push(
        "- Nothing has run these commits: this loop has no VERIFY_CMD, and you cannot run",
        "  them either. A test the diff adds is not a test that passed.",
      );
    }
    const checkedBlock = `\n## What the harness already checked\n\n${checked.join("\n")}\n`;
    // Steering handed to the agent mid-iteration by the steer hook.
    const delivered = this.read(this.p("STEER.md.delivered"));
    if (delivered !== "") steering = steering ? `${steering}\n${chomp(delivered)}` : chomp(delivered);
    writeFileSync(
      this.p(".review-prompt"),
      `You are reviewing commits that another agent just made in ${this.work}. You cannot change
anything; you only judge.

## The job the loop is doing

${job}

## Steering from the human (outranks the job)

${steering || "(none)"}
${doneBlock}${churnBlock}${checkedBlock}
## What to review

The commits are in ${this.p("review.diff")}: each commit's message, then a stat, then
the full diff, capped at 200 KB. That file is everything git knows about them; the
.git in ${this.work} is a file pointing elsewhere, so do not look for history there.
Read it. Read files in ${this.work} if you need context.

Reject when the change is wrong, is not what the job asks for, breaks something
visible in the diff, weakens a test or a measurement so that it passes, or when a
commit message claims a result (a measurement, a check that passes) that neither
the diff nor the checks above support. Otherwise accept. Style alone is not a
reason to reject.

End your reply with exactly one line, either

VERDICT: ACCEPT

or

VERDICT: REJECT: <one sentence saying why>
`,
    );

    const args = reviewerArgs(c, this.dir);
    const reviewOut = this.p("review.out");
    const reviewJson = this.p(".review.json");
    let verdict: string;
    let tries = 0;
    let waited = 0;
    let triedOut = 0;
    let pastCeiling = "";
    let last: Bounded;
    for (;;) {
      writeFileSync(reviewOut, "");
      writeFileSync(reviewJson, "");
      last = await this.bounded(c.ITER_TIMEOUT, ["claude", ...args], { stdin: this.p(".review-prompt"), out: reviewJson, err: reviewOut });
      const r = claudeText(this.read(reviewJson));
      writeFileSync(reviewOut, this.read(reviewOut) + r.text);
      cost = addCost(cost, r.cost);
      tokens = addTokens(tokens, r.tokens);
      const text = this.read(reviewOut);
      this.log.raw(text);
      verdict =
        splitLines(text)
          .filter((l) => l.startsWith("VERDICT:"))
          .at(-1) ?? "";
      // A limit is not an answer: wait it out and ask again. But bounded,
      // unlike the agent's limit: the reviewer waits holding a commit that
      // passed verify and that no gate has judged.
      const hit = !verdict && last.rc !== 0 && !last.timedOut ? limitLine(tailLines(text, 20), this.limitRe) : null;
      if (hit === null) break;
      tries++;
      const ceiling = c.REVIEW_LIMIT_TRIES > 0;
      // A reset time the message names replaces the retries, not the ceiling.
      const reset = c.LIMIT_RESET ? resetAt(hit, nowSec()) : null;
      if (reset) {
        const secs = Math.max(0, reset.epoch - nowSec());
        if (ceiling && waited + secs > c.REVIEW_LIMIT_TRIES * c.RATE_LIMIT_SLEEP) {
          triedOut = tries;
          pastCeiling = reset.at;
          break;
        }
        this.log.line(`reviewer hit a limit that resets at ${reset.at} — waiting until then (try ${tries})`);
        await this.waitUntil(reset.epoch);
        waited += secs;
        continue;
      }
      if (ceiling && tries >= c.REVIEW_LIMIT_TRIES) {
        triedOut = tries;
        break;
      }
      this.log.line(`reviewer hit a limit — asking again in ${c.RATE_LIMIT_SLEEP}s (try ${tries} of ${c.REVIEW_LIMIT_TRIES})`);
      await nap(c.RATE_LIMIT_SLEEP);
      waited += c.RATE_LIMIT_SLEEP;
    }
    if (verdict.startsWith("VERDICT: ACCEPT")) return { status: "accept", reason: "", cost, tokens };
    if (verdict.startsWith("VERDICT: REJECT")) {
      let why = verdict.slice("VERDICT: REJECT".length);
      if (why.startsWith(":")) why = why.slice(1);
      if (why.startsWith(" ")) why = why.slice(1);
      return { status: "reject", reason: `reviewer: ${why}`, cost, tokens };
    }
    let reason: string;
    if (pastCeiling) reason = `reviewer's limit resets at ${pastCeiling}, past the REVIEW_LIMIT_TRIES ceiling`;
    else if (triedOut > 0) reason = `reviewer hit a limit; gave up at try ${triedOut} of ${c.REVIEW_LIMIT_TRIES}`;
    else reason = `reviewer gave no verdict (exit ${last.rc}, timed out ${last.timedOut ? 1 : 0})`;
    return { status: "unavailable", reason, cost, tokens };
  }

  // ------------------------------------------------------------ sync

  /**
   * Follow origin/BRANCH and push kept commits. Runs before every iteration and
   * after every keep, so a push that failed once is retried, and work done
   * while a human pushed to the same branch is rebased and verified again.
   */
  private async sync(): Promise<void> {
    if (this.cfg.PUSH === "pr") await this.syncPr();
    else await this.syncOnce();
    await this.markGated();
  }

  /**
   * A rebase and a verify on a tree git could not clean would judge what is
   * left in it, so sync waits; the clean before the next iteration stops the
   * loop if it fails again.
   */
  private async syncClean(): Promise<boolean> {
    const unclean = await this.cleanTree();
    if (unclean) this.log.line(`sync: could not clean the worktree (${unclean}), not syncing this time`);
    return !unclean;
  }

  private async fetchUpstream(): Promise<boolean> {
    if (await this.fetch(["origin", this.cfg.BRANCH])) return true;
    this.log.line("sync: fetch failed, not pushing this time");
    return false;
  }

  private async syncOnce(): Promise<void> {
    const upstream = `origin/${this.cfg.BRANCH}`;
    if (!(await this.syncClean())) return;
    // Round again after a wait for LAND_OK_CMD: BRANCH may have moved meanwhile,
    // and what is pushed has to be rebased and verified on what it now holds.
    for (;;) {
      if (!(await this.fetchUpstream())) return;
      if ((await this.gitOut(["rev-list", `${upstream}..HEAD`])) === "") {
        await this.git(["reset", "-q", "--hard", upstream]);
        return;
      }
      if (!(await this.gitOk(["merge-base", "--is-ancestor", upstream, "HEAD"]))) {
        const head = await this.gitOut(["rev-parse", "HEAD"]);
        if (!(await this.gitOk(["rebase", "-q", upstream], { toLog: true }))) {
          await this.git(["rebase", "--abort"], { quiet: true });
          await this.saveRef("dropped", head);
          await this.git(["reset", "-q", "--hard", upstream]);
          record(this.results, this.iter, {
            before: head,
            after: await this.gitOut(["rev-parse", "HEAD"]),
            status: "drop:conflict",
            secs: 0,
            reason: `rebase onto ${upstream} conflicted; unpushed commits dropped, saved under ${refPrefix(this.name, "dropped")}`,
          });
          this.log.line(`sync: rebase conflicted, dropped unpushed commits (saved under ${refPrefix(this.name, "dropped")})`);
          return;
        }
        const v = await this.verify();
        if (v !== null) {
          await this.saveRef("dropped", await this.gitOut(["rev-parse", "HEAD"]));
          record(this.results, this.iter, {
            before: head,
            after: await this.gitOut(["rev-parse", "HEAD"]),
            status: "drop:reverify",
            secs: 0,
            reason: `after rebase onto ${upstream}: ${v}`,
          });
          await this.git(["reset", "-q", "--hard", upstream]);
          this.log.line(`sync: rebased commits failed verify, dropped them (saved under ${refPrefix(this.name, "dropped")})`);
          return;
        }
      }
      if (await this.landHeld(`the push to ${upstream}`)) continue;
      const r = await this.bounded(300, ["git", "push", "-q", "origin", `HEAD:${this.cfg.BRANCH}`], { out: this.log.file });
      if (r.rc === 0) this.log.line(`pushed ${await this.gitOut(["rev-parse", "HEAD"])} to ${upstream}`);
      else this.log.line(`sync: push failed (exit ${r.rc}); the commits stay local and the next sync retries`);
      return;
    }
  }

  // PUSH=pr: the harness pushes ralph/<name> to origin and keeps one pull
  // request open into BRANCH; a human merges it, or with PR_MERGE the harness
  // does once the loop ends (mergeAtEnd). Nothing here pushes BRANCH.
  //
  // Unlike syncOnce, this never throws a kept commit away. There the unpushed
  // work is one iteration's at most; here it is everything since the last
  // merge, and the pull request's own checks, or the human reading it, are the
  // last gate anyway. A rebase that conflicts, or passes and then fails
  // VERIFY_CMD, leaves the branch on its old base and tells the human once.

  /** Said once per key — the upstream or remote sha it is about. */
  private async prBlocked(key: string, message: string): Promise<void> {
    const file = this.p(".pr-blocked");
    if (this.read(file).trim() === key) return;
    writeFileSync(file, `${key}\n`);
    this.log.line(`sync: ${message}`);
    await this.notify("pr-blocked", message);
  }

  /** gh, bounded, its output in .gh.out; true when it answered. */
  private async ghRun(secs: number, args: string[]): Promise<boolean> {
    const out = this.p(".gh.out");
    writeFileSync(out, "");
    const r = await this.bounded(secs, ["gh", ...args], { out });
    this.lastGhRc = r.rc;
    return r.rc === 0 && !r.timedOut;
  }
  private lastGhRc = 0;

  /**
   * The head of the newest merged pull request from ralph/<name>, or "". A
   * squash or rebase merge puts the changes on BRANCH as new commits, so a
   * plain rebase would replay every one onto work that already holds them.
   */
  private async prMergedHead(): Promise<string> {
    if (!this.ghOk) return "";
    const ok = await this.ghRun(60, [
      "pr",
      "list",
      "--head",
      `ralph/${this.name}`,
      "--base",
      this.cfg.BRANCH,
      "--state",
      "merged",
      "--limit",
      "1",
      "--json",
      "headRefOid",
      "--jq",
      ".[0].headRefOid // empty",
    ]);
    if (!ok) return "";
    const sha = this.read(this.p(".gh.out")).replace(/\s/g, "");
    return /^[0-9a-f]*$/.test(sha) ? sha : "";
  }

  private async syncPr(): Promise<void> {
    const upstream = `origin/${this.cfg.BRANCH}`;
    if (!(await this.syncClean())) return;
    if (!(await this.fetchUpstream())) return;
    // Nothing of the loop's own that BRANCH lacks: merged, or no work yet.
    if ((await this.gitOut(["rev-list", `${upstream}..HEAD`])) === "") {
      await this.git(["reset", "-q", "--hard", upstream]);
      return;
    }
    if (!(await this.gitOk(["merge-base", "--is-ancestor", upstream, "HEAD"]))) {
      const head = await this.gitOut(["rev-parse", "HEAD"]);
      const merged = await this.prMergedHead();
      if (merged && merged === head) {
        await this.git(["reset", "-q", "--hard", upstream]);
        this.log.line(`sync: the pull request for ralph/${this.name} was merged at ${head}; following ${upstream}`);
        return;
      }
      let ok: boolean;
      if (merged && (await this.gitOk(["merge-base", "--is-ancestor", merged, "HEAD"], { quiet: true }))) {
        ok = await this.gitOk(["rebase", "-q", "--onto", upstream, merged], { toLog: true });
      } else {
        ok = await this.gitOk(["rebase", "-q", upstream], { toLog: true });
      }
      if (!ok) {
        await this.git(["rebase", "--abort"], { quiet: true });
        await this.git(["reset", "-q", "--hard", head]);
        await this.prBlocked(
          `conflict ${await this.gitOut(["rev-parse", upstream])}`,
          `ralph/${this.name} does not rebase onto ${upstream} without conflicts; kept on its old base, nothing dropped — resolve it in the pull request`,
        );
      } else if ((await this.gitOut(["rev-list", `${upstream}..HEAD`])) === "") {
        this.log.line(`sync: every commit on ralph/${this.name} is already on ${upstream}; following it`);
        return;
      } else {
        const v = await this.verify();
        if (v !== null) {
          await this.git(["reset", "-q", "--hard", head]);
          await this.prBlocked(
            `verify ${await this.gitOut(["rev-parse", upstream])}`,
            `rebased onto ${upstream}, ralph/${this.name} fails VERIFY_CMD (${v}); kept on its old base, nothing dropped`,
          );
        }
      }
    }
    await this.prPush();
  }

  /**
   * Push ralph/<name>, overwriting only what this harness pushed there itself.
   * The lease names the exact commit expected on origin (none, when the branch
   * is not there — GitHub deletes it after a merge), so a commit someone else
   * pushed to the branch is never overwritten.
   */
  private async prPush(): Promise<void> {
    const ref = `refs/heads/ralph/${this.name}`;
    const head = await this.gitOut(["rev-parse", "HEAD"]);
    const lsFile = this.p(".ls-remote");
    writeFileSync(lsFile, "");
    const ls = await this.bounded(60, ["git", "ls-remote", "origin", ref], { out: lsFile });
    if (ls.rc !== 0 || ls.timedOut) {
      this.log.line(`sync: cannot read ralph/${this.name} on origin (exit ${ls.rc}); not pushing this time`);
      return;
    }
    const remote = splitLines(this.read(lsFile))
      .map((l) => l.split("\t"))
      .filter((f) => f[1] === ref)
      .map((f) => f[0] ?? "")
      .join("\n");
    if (!/^[0-9a-f]*$/.test(remote)) {
      this.log.line(`sync: cannot read ralph/${this.name} on origin; not pushing this time`);
      return;
    }
    if (remote === head) {
      await this.prEnsure();
      return;
    }
    const pushedFile = this.p(".pr-pushed");
    if (remote && remote !== this.read(pushedFile).trim()) {
      await this.fetch(["origin", `+${ref}:refs/remotes/origin/ralph/${this.name}`]);
      if (!(await this.gitOk(["merge-base", "--is-ancestor", remote, "HEAD"], { quiet: true }))) {
        await this.prBlocked(
          `foreign ${remote}`,
          `ralph/${this.name} on origin holds commits this loop did not push (${remote}); not overwriting them, the loop keeps its work local until a human deletes or resets that branch`,
        );
        return;
      }
    }
    const r = await this.bounded(300, ["git", "push", "-q", `--force-with-lease=${ref}:${remote}`, "origin", `HEAD:${ref}`], {
      out: this.log.file,
    });
    if (r.rc === 0) {
      writeFileSync(pushedFile, `${head}\n`);
      this.log.line(`pushed ${head} to origin ralph/${this.name}`);
      await this.prEnsure();
    } else {
      this.log.line(`sync: push of ralph/${this.name} failed (exit ${r.rc}); the commits stay local and the next sync retries`);
    }
  }

  /** One open pull request from ralph/<name> into BRANCH, opened when there is none. */
  private async prEnsure(): Promise<void> {
    if (!this.ghOk) return;
    const c = this.cfg;
    const listed = await this.ghRun(60, [
      "pr",
      "list",
      "--head",
      `ralph/${this.name}`,
      "--base",
      c.BRANCH,
      "--state",
      "open",
      "--limit",
      "1",
      "--json",
      "url",
      "--jq",
      ".[0].url // empty",
    ]);
    if (!listed) {
      this.log.line(`sync: gh pr list failed (exit ${this.lastGhRc}); asking again next sync`);
      return;
    }
    if (splitLines(this.read(this.p(".gh.out"))).some((l) => l.startsWith("http"))) return;
    const gates: string[] = [];
    if (c.VERIFY_CMD) gates.push("VERIFY_CMD");
    if (c.REVIEW) gates.push("a read-only reviewer");
    if (c.FROZEN.length) gates.push("the frozen-file check");
    writeFileSync(
      this.p(".pr-body"),
      `Commits kept by the ralph loop \`${this.name}\`. Each one passed ${gates.join(", ") || "no gate but the commit itself"} before it was pushed here.\n\n` +
        `The loop keeps pushing to this branch until the pull request is merged, and rebases it onto \`${c.BRANCH}\` as that moves. ` +
        "Merge with a merge commit or a rebase; a squash merge works too, because the harness asks gh which head was merged.\n\n" +
        "Do not push to this branch yourself: the harness never overwrites commits it did not push, and stops pushing until they are gone.\n" +
        (c.PR_DRAFT
          ? "\nIt stays a draft while the loop runs, and the harness marks it ready when the loop ends by itself. Merging it before then cuts the loop's work in half.\n"
          : "") +
        (c.LAND_OK_CMD
          ? `\nBefore you merge it by hand, check that \`${c.LAND_OK_CMD}\` passes: the loop holds its own pushes and merges into \`${c.BRANCH}\` until it does.\n`
          : ""),
    );
    const draft = c.PR_DRAFT && !this.ended ? ["--draft"] : [];
    const created = await this.ghRun(120, [
      "pr",
      "create",
      "--base",
      c.BRANCH,
      "--head",
      `ralph/${this.name}`,
      "--title",
      `ralph: ${this.name}`,
      "--body-file",
      this.p(".pr-body"),
      ...draft,
    ]);
    const out = this.read(this.p(".gh.out"));
    if (created) {
      const url = [...out.matchAll(/https?:\/\/\S+/g)].at(-1)?.[0] ?? "";
      this.log.line(`opened pull request ${url || "(gh printed no URL)"} for ralph/${this.name} into ${c.BRANCH}`);
      await this.notify("pr", `opened ${url || "a pull request"} for ralph/${this.name} into ${c.BRANCH}`);
    } else {
      this.log.line(`sync: gh pr create failed (exit ${this.lastGhRc}): ${lastNonBlank(splitLines(out))}; trying again next sync`);
    }
  }

  // ------------------------------------------------------------ merge at the end

  /**
   * PR_MERGE: once the loop has ended by itself, merge its pull request into
   * BRANCH if every check on it passes. Three things tie what is merged to what
   * was checked: the branch must sit on BRANCH as origin has it, so the checks
   * ran on what BRANCH will hold; the head must be the one the harness pushed;
   * and `--match-head-commit` makes GitHub refuse any other. The wait is bounded
   * by PR_MERGE_WAIT, because it holds work whose last gate has not answered.
   * A signal never gets here: a stop is the human's call, and so is the merge.
   */
  private async mergeAtEnd(): Promise<void> {
    const c = this.cfg;
    if (!c.PR_MERGE || c.PUSH !== "pr" || !this.harnessPushes()) return;
    const branch = `ralph/${this.name}`;
    if (!this.ghOk) {
      this.log.line(`PR_MERGE: gh is missing or not logged in — merge the pull request from ${branch} by hand`);
      return;
    }
    const upstream = `origin/${c.BRANCH}`;
    const poll = c.PR_MERGE_POLL >= 1 ? c.PR_MERGE_POLL : 30;
    const naps = Math.max(0, Math.floor(c.PR_MERGE_WAIT / poll));
    this.log.line(`PR_MERGE: the loop ended; merging ${branch} into ${c.BRANCH} once its checks pass, waiting up to ${naps * poll}s`);
    let url = "";
    let none = 0;
    // Counts only the looks at the checks: a wait for LAND_OK_CMD is not the
    // checks being slow, and must not use up PR_MERGE_WAIT.
    let n = 0;
    for (;;) {
      // Each reading syncs first, as an iteration does: BRANCH can move while
      // the checks run, and what is merged has to be what they ran on.
      await this.sync();
      const head = await this.gitOut(["rev-parse", "HEAD"]);
      if ((await this.gitOut(["rev-list", `${upstream}..HEAD`])) === "") {
        this.log.line(`PR_MERGE: ${c.BRANCH} already holds everything on ${branch}; nothing to merge`);
        return;
      }
      if (!(await this.gitOk(["merge-base", "--is-ancestor", upstream, "HEAD"], { quiet: true }))) {
        return this.mergeBlocked(
          `${branch} does not sit on ${upstream}: it conflicts with it, or fails VERIFY_CMD on top of it; not merging work nothing checked on top of ${c.BRANCH}`,
          url,
        );
      }
      let why: string;
      if (this.read(this.p(".pr-pushed")).trim() !== head) {
        none = 0;
        why = `${head} is not on origin, because its push did not go through`;
      } else {
        const viewed = await this.ghRun(60, ["pr", "view", branch, "--json", "url,state,headRefOid,statusCheckRollup"]);
        const r = viewed ? readChecks(this.read(this.p(".gh.out")), head) : { url: "", checks: { verdict: "unreadable" } as Checks };
        url = r.url || url;
        const k = r.checks;
        if (k.verdict === "merged") {
          this.log.line(`PR_MERGE: ${url || `the pull request from ${branch}`} is already merged`);
          return;
        }
        if (k.verdict === "closed") return this.mergeBlocked(`the pull request from ${branch} was closed without merging`, url);
        if (k.verdict === "fail") return this.mergeBlocked(`checks failed on ${head}: ${k.names.join(", ")}`, url);
        if (k.verdict === "pass") {
          if (await this.landHeld(`the merge of ${branch} into ${c.BRANCH}`)) continue;
          return this.mergePr(branch, head, url, "every check passed");
        }
        if (k.verdict === "none") {
          // Twice, a poll apart: just after a push GitHub may not have
          // registered the checks it is about to run.
          if (++none >= 2) {
            if (c.VERIFY_CMD) {
              if (await this.landHeld(`the merge of ${branch} into ${c.BRANCH}`)) continue;
              return this.mergePr(branch, head, url, "no CI checks, and VERIFY_CMD passed on every commit");
            }
            return this.mergeBlocked(`the pull request has no CI checks and the loop has no VERIFY_CMD, so nothing tested ${head}`, url);
          }
          why = "no checks reported";
        } else {
          none = 0;
          why =
            k.verdict === "pending"
              ? `checks still running: ${k.names.join(", ")}`
              : k.verdict === "stale"
                ? `GitHub shows ${k.seen || "no commit"} as the head of the pull request, not ${head}`
                : `gh pr view gave no readable answer (exit ${this.lastGhRc})`;
        }
      }
      if (n >= naps) return this.mergeBlocked(`gave up after PR_MERGE_WAIT=${c.PR_MERGE_WAIT}s: ${why}`, url);
      n++;
      await nap(poll);
    }
  }

  /**
   * PR_DRAFT: the pull request has been a draft while the loop ran, which
   * GitHub will not merge, so a stage cannot be merged half done. Marked ready
   * once the loop ends by itself, and before PR_MERGE waits for the checks:
   * some CI does not run on a draft. After a signal it stays a draft; the human
   * who stopped the loop decides.
   */
  private async prReady(): Promise<void> {
    const c = this.cfg;
    if (!c.PR_DRAFT || c.PUSH !== "pr" || !this.harnessPushes() || !this.ghOk) return;
    const branch = `ralph/${this.name}`;
    if (!(await this.ghRun(60, ["pr", "ready", branch]))) {
      this.log.line(
        `PR_DRAFT: gh pr ready ${branch} failed (exit ${this.lastGhRc}): ${lastNonBlank(splitLines(this.read(this.p(".gh.out"))))}`,
      );
      return;
    }
    this.log.line(`PR_DRAFT: the loop ended; marked the pull request from ${branch} ready`);
    // With PR_MERGE the merged or merge-blocked event follows and says it all.
    if (!c.PR_MERGE) await this.notify("pr-ready", `the loop ended; the pull request from ${branch} into ${c.BRANCH} is ready to merge`);
  }

  private async mergePr(branch: string, head: string, url: string, why: string): Promise<void> {
    const c = this.cfg;
    const pr = url || `the pull request from ${branch}`;
    if (!(await this.ghRun(120, ["pr", "merge", branch, `--${c.PR_MERGE_METHOD}`, "--match-head-commit", head]))) {
      const said = lastNonBlank(splitLines(this.read(this.p(".gh.out"))));
      return this.mergeBlocked(`gh pr merge did not merge ${pr} (exit ${this.lastGhRc}): ${said}`, "");
    }
    const message = `merged ${pr} into ${c.BRANCH} at ${head} (${c.PR_MERGE_METHOD}: ${why})`;
    this.log.line(`PR_MERGE: ${message}`);
    await this.notify("merged", message);
  }

  private async mergeBlocked(message: string, url: string): Promise<void> {
    const full = `${message}${url ? ` — ${url}` : ""}`;
    this.log.line(`PR_MERGE: ${full}`);
    await this.notify("merge-blocked", full);
  }
}
