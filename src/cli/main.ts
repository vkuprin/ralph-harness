import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stampMinutes } from "../lib/clock.ts";
import { checkSetting, parseConfig, pushProblem } from "../lib/config.ts";
import { readResults } from "../lib/results.ts";
import { Log } from "../lib/log.ts";
import { hint } from "../lib/shq.ts";
import { splitLines } from "../lib/text.ts";
import { HARNESS, LOOP_ENTRY, LOOP_MARK, TEMPLATE, ralphHome } from "../paths.ts";
import { migrate } from "./migrate.ts";

const USAGE = `ralph — long-running Claude Code loops: a fresh \`claude -p\` every iteration,
and git, not the model, decides what shipped.

Getting started
  ralph setup                      set a loop up with Claude, for the repo you are in
  ralph new audit ~/code/my-app    or make one yourself
  ralph edit audit                 write the job into its PROMPT.md
  ralph start audit                run it in the background
  ralph review audit               later: what it shipped, what it threw away

Commands
  ralph setup                    open Claude Code here with the ralph-new skill
                                 loaded; it asks how the loop should run and
                                 scaffolds it. \`ralph new\` alone does the same
  ralph new <name> <repo-path> [--set KEY=VALUE]...
                                 scaffold a loop from the template. The name is
                                 a directory and, with WORKTREE on, the branch
                                 ralph/<name>, so it has to be usable as both.
                                 --set writes a setting into its config.json:
                                 VALUE as JSON (true, 3, "pr", ["a"]), or as a
                                 plain string when it is not JSON
  ralph start <name>             run it in the background
  ralph stop <name>              stop the loop and the agent inside it
  ralph status [name]            what is running, how long, how far
  ralph review <name> [n]        what the loop shipped, reverted, and has waiting to merge
  ralph results <name> [n]       the harness verdict for each iteration (default 20)
  ralph log <name> [n]           last n lines of the log, rotated files included (default 40)
  ralph tail <name>              follow the log, across rotations
  ralph steer <name> "text"      redirect a running loop, starting with the iteration in flight
  ralph edit <name>              open PROMPT.md in $EDITOR
  ralph migrate <name>           convert a loop's config.sh to config.json
  ralph --version                the installed version

With no arguments it prints this, then the loops you have.

Loops live in $RALPH_HOME (default ~/.claude/ralph), one directory each. The
harness lives where ralph is installed; loop contents stay on the machine,
because they hold task state and production details. \`log\` and \`tail\` read
ralph.log, which holds the agent's output and the harness's own errors both;
nothing you need is only in the ralph.out that \`start\` leaves beside it.
`;

const HOME = ralphHome();
const out = (s: string) => process.stdout.write(s);
const red = (s: string) => `\x1b[31m${s}\x1b[0m\n`;
const green = (s: string) => out(`\x1b[32m${s}\x1b[0m\n`);
const dim = (s: string) => out(`\x1b[2m${s}\x1b[0m\n`);

function die(msg: string): never {
  process.stderr.write(red(`ralph: ${msg}`));
  process.exit(1);
}

function read(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function loopDir(name: string | undefined): string {
  if (!name) die("which loop? try: ralph status");
  return join(HOME, name);
}

function sh(argv: string[], cwd?: string): { code: number; out: string } {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { code: r.status ?? (r.error ? 127 : 1), out: r.stdout ?? "" };
}

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  return sh(["git", "-C", cwd, ...args]);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandOf(pid: string): string {
  return sh(["ps", "-ww", "-p", pid, "-o", "command="]).out.trimEnd();
}

/**
 * A PID is not an identity. ralph.pid outlives a `kill -9`, the OOM killer and
 * a reboot, and after a reboot the kernel hands those low numbers straight back
 * out: `kill -0` then says "running" about a stranger, and `ralph stop` would
 * TERM and then KILL that stranger's whole process group. `ralph start` puts
 * this loop's directory at the end of the loop's command line, so the loop is
 * the process whose command line ends with it, and nothing else counts. A
 * literal match: a path is not a pattern.
 */
function pidOf(dir: string, bashToo = false): string | null {
  const pid = read(join(dir, "ralph.pid")).trim();
  if (!/^\d+$/.test(pid) || !alive(Number(pid))) return null;
  const cmd = commandOf(pid);
  if (!cmd.endsWith(` ${dir}`)) return null;
  if (cmd.includes(`${LOOP_MARK} `)) return pid;
  // The bash harness this replaced ran `bash <harness>/ralph.sh <dir>`.
  if (bashToo && cmd.includes("ralph") && cmd.includes(".sh ")) return pid;
  return null;
}

type Kind = "current" | "sh";
/** Which kind of loop a directory holds: config.json, or settings still in config.sh. */
function loopKind(dir: string): Kind | null {
  if (existsSync(join(dir, "config.json"))) return "current";
  if (existsSync(join(dir, "config.sh"))) return "sh";
  return null;
}

interface Conf {
  repo: string;
  worktree: boolean;
  branch: string;
  push: false | true | "pr";
  merge: boolean;
  work: string;
}

/**
 * REPO, WORKTREE, BRANCH, PUSH and the work directory, read loosely: what the
 * CLI shows about a loop, never what decides how it runs. A config that does
 * not parse shows as "?" here and is refused by the loop, which says why.
 */
function loopConf(dir: string): Conf {
  let raw: Record<string, unknown> = {};
  try {
    const j = Bun.JSONC.parse(read(join(dir, "config.json")));
    if (j && typeof j === "object" && !Array.isArray(j)) raw = j as Record<string, unknown>;
  } catch {}
  const str = (k: string, d: string) => (typeof raw[k] === "string" ? (raw[k] as string) : d);
  const bool = (v: unknown) => v === true || v === 1;
  const repo = str("REPO", "");
  const worktree = bool(raw.WORKTREE);
  const push = raw.PUSH === "pr" ? "pr" : bool(raw.PUSH);
  let work = repo;
  if (worktree && repo) work = str("WORKTREE_DIR", "") || join(dirname(repo), `${basename(repo)}-ralph-${basename(dir)}`);
  return { repo, worktree, branch: str("BRANCH", "main"), push, merge: bool(raw.PR_MERGE), work };
}

function stateLine(dir: string): string {
  const pid = pidOf(dir);
  if (!pid) return "\x1b[2mstopped\x1b[0m";
  const up = sh(["ps", "-p", pid, "-o", "etime="]).out.trim();
  return `\x1b[32mrunning\x1b[0m  PID ${pid}  up ${up}`;
}

/**
 * The loop rotates its log, so the history is spread over ralph.log and the
 * ralph.log.N behind it. Anything that reads the log reads them all, oldest
 * first — numerically, because ralph.log.10 sorts under ralph.log.2 by name.
 */
function logFiles(dir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const rotated = names
    .map((f) => /^ralph\.log\.(\d+)$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map((m) => join(dir, m[0]));
  if (existsSync(join(dir, "ralph.log"))) rotated.push(join(dir, "ralph.log"));
  return rotated;
}

function logCount(dir: string, re: RegExp): number {
  let n = 0;
  for (const f of logFiles(dir)) for (const l of splitLines(read(f))) if (re.test(l)) n++;
  return n;
}

function statusIterations(dir: string): void {
  out(`  iterations  ${logCount(dir, /^\[.*=== iteration/)} run, ${logCount(dir, /shipped [0-9a-f]{40}/)} shipped a commit\n`);
}

function statusLast(dir: string): void {
  const last = splitLines(read(join(dir, "ralph.log")))
    .filter((l) => l.startsWith("["))
    .at(-1);
  if (last) out(`  last        ${last}\n`);
}

/**
 * What the runs cost, from the columns the harness fills when claude answers in
 * JSON. On a subscription the dollars are what the API would have charged, not
 * a bill, and a run killed before it answered reports nothing: a lower bound.
 */
function costLine(results: string): string {
  let c = 0;
  let t = 0;
  let k = 0;
  let any = false;
  for (const r of readResults(results).rows) {
    if (r.length < 9) continue;
    if (r[7] !== "-") {
      c += Number(r[7]) || 0;
      any = true;
    }
    if (r[8] !== "-") t += Number(r[8]) || 0;
    if ((r[4] ?? "").startsWith("keep")) k++;
  }
  if (!any) return "";
  return `$${c.toFixed(2)} API-equivalent (a lower bound), ${Math.trunc(t)} tokens${k ? `, $${(c / k).toFixed(2)} per kept commit` : ""}`;
}

function verdictCounts(results: string, byCount: boolean): string {
  const counts = new Map<string, number>();
  for (const r of readResults(results).rows) counts.set(r[4] ?? "", (counts.get(r[4] ?? "") ?? 0) + 1);
  const entries = [...counts.entries()];
  if (byCount) entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  else entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.map(([s, n]) => `${n} ${s}`).join(", ");
}

/** Prints one loop, or returns false without printing if the directory is not a loop. */
function statusOne(dir: string): boolean {
  const name = basename(dir);
  const kind = loopKind(dir);
  if (!kind) return false;
  if (kind === "sh") {
    out(`${name.padEnd(20)} ${stateLine(dir)}  \x1b[2m(settings in config.sh — convert them: ${hint("ralph", "migrate", name)})\x1b[0m\n`);
    statusIterations(dir);
    statusLast(dir);
    out("\n");
    return true;
  }
  const c = loopConf(dir);
  out(`${name.padEnd(20)} ${stateLine(dir)}\n`);
  out(`  repo        ${c.repo || "?"}\n`);
  if (c.worktree) out(`  worktree    ${c.work} (ralph/${name})\n`);
  statusIterations(dir);
  const results = join(dir, "results.tsv");
  if (existsSync(results)) {
    const v = verdictCounts(results, false);
    if (v) out(`  verdicts    ${v}\n`);
    const cost = costLine(results);
    if (cost) out(`  cost        ${cost}\n`);
  }
  statusLast(dir);
  // No REPO leaves the work directory empty, and `git -C ""` leaves the working
  // directory alone — so a loop that died on its own config was once reported
  // with the HEAD of whatever repository the reader stood in.
  if (c.work) {
    const head = git(c.work, "log", "--oneline", "-1");
    if (head.code === 0 && head.out.trim()) out(`  HEAD        ${head.out.trim()}\n`);
  }
  out("\n");
  return true;
}

function loopNames(): string[] {
  try {
    return readdirSync(HOME)
      .filter((d) => isDir(join(HOME, d)))
      .sort();
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ commands

/**
 * Copy a template, replacing __NAME__ and __REPO__ with exactly those strings
 * and "__REPO_JSON__", quotes and all, with the repo path as a JSON string —
 * quoted in the template so the template itself parses. Two placeholders for
 * one value are two jobs: __REPO_JSON__ is the value config.json holds, and
 * __REPO__ is the raw path in a comment the reader pastes. The longer name is
 * replaced first, since __REPO__ is its prefix. No replacement strings — a
 * `$&` in a path would be read as syntax — only cutting and joining.
 */
function fill(src: string, name: string, repo: string): string {
  let text = read(src);
  for (const [ph, val] of [
    ['"__REPO_JSON__"', JSON.stringify(repo)],
    ['"__SCHEMA_JSON__"', JSON.stringify(pathToFileURL(join(TEMPLATE, "config.schema.json")).href)],
    ["__REPO__", repo],
    ["__NAME__", name],
  ] as const) {
    text = text.split(ph).join(val);
  }
  return text;
}

/**
 * `--set KEY=VALUE` arguments, each judged as config.json would judge it.
 * VALUE is read as JSON when it is JSON and suits the key, else as the string
 * it is, so `PUSH=pr`, `REVIEW=false` and `VERIFY_CMD=bun test` all mean what
 * they say.
 */
function parseSets(rest: string[]): [string, unknown][] {
  const sets: [string, unknown][] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    let kv: string;
    if (a === "--set" && i + 1 < rest.length) kv = rest[++i]!;
    else if (a.startsWith("--set=")) kv = a.slice("--set=".length);
    else die(`ralph new takes <name> <repo-path> and --set KEY=VALUE, not ${JSON.stringify(a)}`);
    const eq = kv.indexOf("=");
    if (eq <= 0) die(`--set wants KEY=VALUE, not ${JSON.stringify(kv)}`);
    const key = kv.slice(0, eq);
    const text = kv.slice(eq + 1);
    if (key === "REPO") die("REPO is the <repo-path> argument of ralph new, not a --set");
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    let c = checkSetting(key, parsed);
    if (!c.ok && parsed !== text) {
      const raw = checkSetting(key, text);
      if (raw.ok) c = raw;
    }
    if (!c.ok) die(`--set ${c.error}`);
    sets.push([key, c.value]);
  }
  return sets;
}

/**
 * The config template with each setting written in: on the key's own line
 * when the template has one — commented out or not, so the documentation above
 * it stays with it — else just before the closing brace. Values go in only
 * through JSON.stringify, and lines are cut and joined, never replaced by a
 * pattern.
 */
function setKeys(text: string, sets: [string, unknown][]): string {
  const lines = text.split("\n");
  const bare = (l: string) => {
    const t = l.trimStart();
    return t.startsWith("//") ? t.slice(2).trimStart() : t;
  };
  for (const [key, value] of sets) {
    const own = `"${key}": ${JSON.stringify(value)},`;
    let at = lines.findIndex((l) => l.trimStart().startsWith(`"${key}":`));
    if (at < 0) at = lines.findIndex((l) => l.trimStart().startsWith("//") && bare(l).startsWith(`"${key}":`));
    if (at >= 0) {
      const line = lines[at]!;
      lines[at] = line.slice(0, line.length - line.trimStart().length) + own;
    } else {
      at = lines.findLastIndex((l) => l.trim() === "}");
      if (at < 0) die("template/config.json has no closing brace");
      lines.splice(at, 0, `  ${own}`);
    }
    // The entry before it needs its comma now: the template's last setting has
    // none, and a commented-out one after it becomes a setting of its own.
    for (let i = at - 1; i >= 0; i--) {
      const t = lines[i]!.trim();
      if (t === "" || t.startsWith("//")) continue;
      if (!t.endsWith(",") && !t.endsWith("{")) lines[i] = `${lines[i]!.trimEnd()},`;
      break;
    }
  }
  return lines.join("\n");
}

function cmdNew(args: string[]): void {
  const [name, repoArg, ...rest] = args;
  if (!name || !repoArg || name.startsWith("--") || repoArg.startsWith("--")) {
    die("usage: ralph new <name> <repo-path> [--set KEY=VALUE]... — or run `ralph setup` in the repository");
  }
  // The name is a directory under $RALPH_HOME and, with WORKTREE on, the branch
  // ralph/<name>. Judged before anything is written, so the complaint arrives
  // with the name in it rather than at every start, in git's words. A `/` is
  // the case git lets through: ralph/a/b is a fine branch, but it nests the
  // loop directory one level down where `ralph status` never looks.
  if (name.includes("/")) die(`loop name cannot hold a /: ${name} — a loop is one directory in ${HOME}`);
  if (sh(["git", "check-ref-format", "--branch", `ralph/${name}`]).code !== 0) {
    die(`loop name is not usable as a git branch: ${name} — with WORKTREE on the loop runs on ralph/${name}`);
  }
  const repo = resolve(repoArg);
  if (!isDir(repo)) die(`no such directory: ${repoArg}`);
  if (!isDir(join(repo, ".git"))) die(`not a git checkout: ${repo}`);
  // A newline would end the comment the raw path sits in, in the template.
  if (repo.includes("\n")) die(`a repo path cannot hold a newline: ${JSON.stringify(repo)}`);
  const dir = join(HOME, name);
  if (existsSync(dir)) die(`loop already exists: ${dir}`);
  // Every setting is judged, and the config written and read back, before the
  // loop directory exists: a refused --set leaves nothing behind.
  const sets = parseSets(rest);
  const config = setKeys(fill(join(TEMPLATE, "config.json"), name, repo), sets);
  const back = parseConfig(config, "config.json", dir);
  if (!back.ok) die(`the config ralph new wrote does not read back: ${back.error}`);
  for (const [key, value] of sets) {
    const got = (back.config as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(got) !== JSON.stringify(value)) die(`--set ${key} did not reach config.json: it reads back as ${JSON.stringify(got)}`);
  }
  // The loop would refuse to start on it, so it is not a scaffold either.
  const push = pushProblem(back.config);
  if (push) {
    die(`${push} — add ${hint("--set", `PUSH_CONFIRM=${back.config.BRANCH}`)} to mean it, or ${hint("--set", "PUSH=pr")} to land through a pull request; nothing was created`);
  }
  // A scaffold the harness could not write is not a scaffold, and the exit
  // status is the only part a script can read.
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    die(`cannot create the loop directory: ${dir}`);
  }
  copyFileSync(join(TEMPLATE, "PROGRESS.md"), join(dir, "PROGRESS.md"));
  writeFileSync(join(dir, "config.json"), config);
  writeFileSync(join(dir, "PROMPT.md"), fill(join(TEMPLATE, "PROMPT.md"), name, repo));
  green(`created ${dir}`);
  for (const [key, value] of sets) dim(`  ${key} = ${JSON.stringify(value)}`);
  dim(`  1. write the job into ${dir}/PROMPT.md`);
  dim(`  2. check the commands in ${dir}/config.json`);
  dim(`  3. ${hint("ralph", "start", name)}`);
}

/**
 * The loop has run its own first lines: it holds ralph.lock under its PID, or
 * it has already exited (a refusal says why in ralph.log). Both take a moment.
 */
function booted(dir: string, pid: number, exited: () => boolean): boolean {
  return exited() || !alive(pid) || read(join(dir, "ralph.lock")).trim() === String(pid);
}

// Now and then bun on Linux never finishes loading the loop's modules: the
// process sits in epoll with no child and no line of its own written, and a
// loop that `ralph status` calls running does nothing for ever. So a start is
// not believed until the loop has run its first lines. One that has not within
// BOOT_WAIT seconds is killed and started again, a few times, and ralph.log
// says so.
const BOOT_WAIT = Number(process.env.RALPH_TEST_BOOT_WAIT) || 30;
const BOOT_TRIES = 3;

async function cmdStart(name?: string): Promise<void> {
  const dir = loopDir(name);
  if (!isDir(dir)) die(`no such loop: ${name}`);
  if (loopKind(dir) === "sh") die(`${name} keeps its settings in config.sh — convert them first: ${hint("ralph", "migrate", name!)}`);
  const running = pidOf(dir);
  if (running) die(`already running as PID ${running}`);
  const log = new Log(join(dir, "ralph.log"));
  for (let attempt = 1; ; attempt++) {
    const fd = openSync(join(dir, "ralph.out"), "a");
    const child = spawn(process.execPath, [LOOP_ENTRY, dir], { detached: true, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    child.unref();
    const pid = child.pid!;
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    writeFileSync(join(dir, "ralph.pid"), `${pid}\n`);
    for (let waited = 0; waited < BOOT_WAIT * 10 && !booted(dir, pid, () => exited); waited++) await Bun.sleep(100);
    if (booted(dir, pid, () => exited)) {
      green(`started ${name} as PID ${pid}`);
      dim(`  ${hint("ralph", "status", name!)}   ${hint("ralph", "tail", name!)}   ${hint("ralph", "stop", name!)}`);
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(join(dir, "ralph.pid"), { force: true });
    const why = `the loop process ${pid} had not started after ${BOOT_WAIT}s (bun never finished loading it)`;
    if (attempt >= BOOT_TRIES) {
      log.line(`ralph start: ${why}; gave up after ${BOOT_TRIES} tries`);
      die(`${why}; gave up after ${BOOT_TRIES} tries — see ${join(dir, "ralph.log")}`);
    }
    log.line(`ralph start: ${why}; killed it and started it again`);
  }
}

async function cmdStop(name?: string): Promise<void> {
  const dir = loopDir(name);
  const pid = pidOf(dir);
  if (!pid) die(`${name} is not running`);
  // TERM lets the loop take down the agent's whole process group (tests, dev
  // servers, MCP servers) and log where it stopped. That can take a few
  // seconds, so wait before reaching for SIGKILL.
  try {
    process.kill(Number(pid), "SIGTERM");
  } catch {}
  for (let i = 0; i < 15 && alive(Number(pid)); i++) await Bun.sleep(1000);
  if (alive(Number(pid))) {
    // Killing only the loop would leave the current `claude -p` orphaned and
    // still writing to the repository.
    for (const child of splitLines(sh(["pgrep", "-P", pid]).out)) {
      try {
        process.kill(-Number(child), "SIGKILL");
      } catch {
        try {
          process.kill(Number(child), "SIGKILL");
        } catch {}
      }
    }
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {}
  }
  rmSync(join(dir, "ralph.pid"), { force: true });
  green(`stopped ${name} (PID ${pid})`);
}

function cmdStatus(name?: string): void {
  if (name) {
    if (!statusOne(join(HOME, name))) dim(`no loop called ${name} in ${HOME}`);
    return;
  }
  let found = false;
  for (const d of loopNames()) if (statusOne(join(HOME, d))) found = true;
  if (!found) dim(`no loops in ${HOME} — ralph new <name> <repo>`);
}

function cmdLog(name?: string, n = "40"): void {
  const dir = loopDir(name);
  const files = logFiles(dir);
  if (!files.length) die(`no log yet for ${name}`);
  const all = splitLines(files.map(read).join(""));
  const k = Number.parseInt(n, 10) || 40;
  out(all.slice(Math.max(0, all.length - k)).map((l) => `${l}\n`).join(""));
}

async function cmdTail(name?: string): Promise<void> {
  const dir = loopDir(name);
  // -F, not -f: a rotation renames the file this is following, and -f would
  // then sit on the old one, silent, for the rest of the run.
  const c = spawn("tail", ["-F", join(dir, "ralph.log")], { stdio: "inherit" });
  await new Promise((r) => c.once("exit", r));
}

/**
 * What a loop did, for a human deciding what to keep: verdict counts, the
 * commits it shipped, the ones the gates threw away (kept under refs/ralph/),
 * and, when it does not push, what is waiting on ralph/<name> to be merged.
 */
function cmdReview(name?: string, nArg = "10"): void {
  const dir = loopDir(name);
  const n = Number.parseInt(nArg, 10) || 10;
  if (!existsSync(join(dir, "config.json"))) {
    if (existsSync(join(dir, "config.sh"))) die(`${name} keeps its settings in config.sh — convert them first: ${hint("ralph", "migrate", name!)}`);
    die(`no loop called ${name} in ${HOME}`);
  }
  const c = loopConf(dir);
  if (!c.work || git(c.work, "rev-parse", "--git-dir").code !== 0) die(`cannot read the repository at ${c.work}`);
  let where = `works in ${c.repo}`;
  if (c.worktree) {
    where = `works on ralph/${name} in ${c.work}`;
    if (c.push === true) where += `, pushes to origin/${c.branch}`;
    else if (c.push === "pr") where += `, pushes it for a pull request into ${c.branch}${c.merge ? ", and merges that when the loop ends if its checks pass" : ""}`;
    else where += ", you merge";
  }
  out(`${name} — ${where}\n`);

  const results = join(dir, "results.tsv");
  if (existsSync(results)) {
    out(`\nVerdicts   ${verdictCounts(results, true)}\n`);
    const cost = costLine(results);
    if (cost) out(`Cost       ${cost}\n`);
    out("\nShipped, newest first\n");
    let shown = 0;
    const shas = readResults(results)
      .rows.filter((r) => (r[4] ?? "").startsWith("keep"))
      .map((r) => r[3] ?? "")
      .reverse();
    for (const sha of shas) {
      if (shown >= n) break;
      const l = git(c.work, "log", "-1", "--format=  %h  %s", sha);
      if (l.code === 0) {
        out(l.out);
        shown++;
      }
    }
    if (!shown) dim("  nothing yet");
  } else {
    dim("no verdicts yet");
  }

  // Newest first, by the epoch the harness put in the refname — numerically,
  // and across both kinds: sorting by name put every reverted above every
  // dropped, so a loop with many reverts never showed a dropped commit at all.
  out("\nReverted or dropped by the gates, kept under refs/ralph/\n");
  const refs = splitLines(git(c.work, "for-each-ref", "--format=%(refname)", "refs/ralph/reverted/", "refs/ralph/dropped/").out);
  const epoch = (r: string) => Number.parseInt(r.split("/")[3] ?? "", 10) || 0;
  refs.sort((a, b) => epoch(b) - epoch(a) || (a < b ? 1 : a > b ? -1 : 0));
  let listed = 0;
  for (const ref of refs.slice(0, n)) {
    const l = git(c.work, "log", "-1", `--format=  %h  %s  (${ref.slice("refs/".length)})`, ref);
    if (l.code === 0) {
      out(l.out);
      listed++;
    }
  }
  if (!listed) dim("  nothing");

  if (c.worktree && c.push !== true) {
    const base = git(c.work, "rev-parse", "-q", "--verify", `origin/${c.branch}`).code === 0 ? `origin/${c.branch}` : c.branch;
    const waiting = git(c.work, "log", "--reverse", "--format=  %h  %s", `${base}..ralph/${name}`);
    out(`\nWaiting to merge into ${c.branch}\n`);
    if (waiting.code === 0 && waiting.out.trim()) {
      out(waiting.out);
      if (c.push === "pr" && c.merge) dim(`  PR_MERGE merges the pull request from ralph/${name} when the loop ends, if its checks pass`);
      else if (c.push === "pr") dim(`  merge them through the pull request from ralph/${name}`);
      else dim(`  merge them: ${hint("git", "-C", c.repo, "merge", `ralph/${name}`)}`);
    } else {
      dim("  nothing");
    }
  }
  out("\n");
  dim(`look closer: ${hint("git", "-C", c.work)} show <sha>     every verdict: ${hint("ralph", "results", name!)}`);
}

function cmdResults(name?: string, nArg = "20"): void {
  const dir = loopDir(name);
  const file = join(dir, "results.tsv");
  if (!existsSync(file)) die(`no results yet for ${name}`);
  const n = Number.parseInt(nArg, 10) || 20;
  const { header, rows } = readResults(file);
  const table = [header.split("\t"), ...rows.slice(Math.max(0, rows.length - n))];
  const widths: number[] = [];
  for (const r of table) r.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, [...cell].length)));
  for (const r of table) {
    out(`${r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ")}\n`);
  }
}

/**
 * Two channels. PROMPT.md is re-read at the start of every iteration, so the
 * steer holds for every iteration after this one. STEER.md is picked up by a
 * PreToolUse hook at the running agent's next tool call (LIVE_STEER), so the
 * iteration in flight hears it too.
 */
function cmdSteer(name?: string, ...words: string[]): void {
  const text = words.join(" ");
  if (!text) die('usage: ralph steer <name> "what to do instead"');
  const dir = loopDir(name);
  const promptFile = join(dir, "PROMPT.md");
  if (!existsSync(promptFile)) die(`no such loop: ${name}`);
  const MARK = "<!-- ralph-steer -->";
  // The marker is what makes this repeatable: entries always land directly
  // under it, newest first, without re-parsing the prose around them.
  if (!read(promptFile).includes(MARK)) {
    appendFileSync(promptFile, `\n## Steering\n\nAdded while the loop was running, newest first. These outrank the backlog below.\n\n${MARK}\n`);
  }
  const lines: string[] = [];
  let seen = false;
  for (const line of splitLines(read(promptFile))) {
    lines.push(line);
    if (!seen && line.includes(MARK)) {
      lines.push("", `- [${stampMinutes()}] ${text}`);
      seen = true;
    }
  }
  const tmp = `${promptFile}.tmp.${process.pid}`;
  writeFileSync(tmp, lines.map((l) => `${l}\n`).join(""));
  renameSync(tmp, promptFile);
  appendFileSync(join(dir, "STEER.md"), `${text}\n`);
  green(`steered ${name} — the running iteration sees it at its next tool call, and every later one reads it from PROMPT.md`);
}

/** Claude Code in the current directory, with the ralph-new skill from this checkout loaded. */
async function cmdSetup(): Promise<never> {
  const claude = Bun.which("claude");
  if (!claude) die("claude is not on PATH — install Claude Code first: https://code.claude.com");
  const skill = join(HARNESS, "skills/ralph-new/SKILL.md");
  const prompt = `Set up a ralph loop on the repository in this directory, following the ralph-new instructions in your system prompt. The ralph CLI is ${join(HARNESS, "bin/ralph")}.`;
  const c = spawn(claude, ["--append-system-prompt-file", skill, prompt], { stdio: "inherit", cwd: process.cwd() });
  const code = await new Promise<number>((r) => c.once("exit", (n) => r(n ?? 1)));
  process.exit(code);
}

async function cmdEdit(name?: string): Promise<void> {
  const dir = loopDir(name);
  const c = spawn(process.env.EDITOR || "vi", [join(dir, "PROMPT.md")], { stdio: "inherit" });
  await new Promise((r) => c.once("exit", r));
}

function cmdMigrate(name?: string): void {
  const dir = loopDir(name);
  if (!isDir(dir)) die(`no such loop: ${name}`);
  if (existsSync(join(dir, "config.json"))) die(`${name} already has a config.json — nothing to migrate`);
  if (!existsSync(join(dir, "config.sh"))) die(`${name} has no config.sh to read settings from`);
  // Converting underneath a running loop would leave it running on settings
  // this has already moved.
  const running = pidOf(dir, true);
  if (running) die(`${name} is running as PID ${running} — stop it first: ${hint("ralph", "stop", name!)}`);
  const r = migrate(read(join(dir, "config.sh")), name!);
  if (!r.ok) die(`cannot convert ${join(dir, "config.sh")}: ${r.error}`);
  writeFileSync(join(dir, "config.json"), r.json);
  renameSync(join(dir, "config.sh"), join(dir, "config.sh.old"));
  green(`migrated ${name}`);
  dim(`  settings   ${join(dir, "config.json")}`);
  dim(`  the old file is kept as ${join(dir, "config.sh.old")}`);
  dim(`  check it, then: ${hint("ralph", "start", name!)}`);
}

function cmdHelp(): void {
  out(USAGE);
  const loops: string[] = [];
  for (const d of loopNames()) {
    const dir = join(HOME, d);
    const kind = loopKind(dir);
    if (!kind) continue;
    const flags: string[] = [];
    if (kind === "sh") flags.push("needs ralph migrate");
    if (pidOf(dir)) flags.push("running");
    loops.push(`${d}${flags.length ? ` (${flags.join(", ")})` : ""}`);
  }
  if (loops.length) out(`\nYour loops: ${loops.join(", ")}\n`);
}

const [cmd = "help", ...args] = process.argv.slice(2);
switch (cmd) {
  case "setup":
    await cmdSetup();
    break;
  case "new":
    if (args.length === 0) await cmdSetup();
    cmdNew(args);
    break;
  case "migrate":
    cmdMigrate(args[0]);
    break;
  case "start":
    await cmdStart(args[0]);
    break;
  case "stop":
    await cmdStop(args[0]);
    break;
  case "status":
    cmdStatus(args[0]);
    break;
  case "log":
    cmdLog(args[0], args[1]);
    break;
  case "results":
    cmdResults(args[0], args[1]);
    break;
  case "review":
    cmdReview(args[0], args[1]);
    break;
  case "tail":
    await cmdTail(args[0]);
    break;
  case "steer":
    cmdSteer(args[0], ...args.slice(1));
    break;
  case "edit":
    await cmdEdit(args[0]);
    break;
  case "-h":
  case "--help":
  case "help":
    cmdHelp();
    break;
  case "-v":
  case "--version":
  case "version":
    out(`ralph ${JSON.parse(readFileSync(join(HARNESS, "package.json"), "utf8")).version}\n`);
    break;
  default:
    die(`unknown command: ${cmd} (try: ralph help)`);
}
