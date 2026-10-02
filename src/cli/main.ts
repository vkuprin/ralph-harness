import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stamp, stampMinutes } from "../lib/clock.ts";
import { checkSetting, parseConfig, pushProblem } from "../lib/config.ts";
import { isCheckout, rewrite } from "../lib/files.ts";
import { readResults } from "../lib/results.ts";
import { Log } from "../lib/log.ts";
import { hint } from "../lib/shq.ts";
import { splitLines } from "../lib/text.ts";
import { IS_WIN, claudeProblem, commandLineSync, killTree, orphanSync, reapOrphan, shellCommand, upTimeSync } from "../lib/proc.ts";
import {
  CHILD_FILE,
  HARNESS,
  LEGACY_REFS,
  LOOP_ENTRY,
  LOOP_MARK,
  STARTED_FILE,
  STOP_FILE,
  TEMPLATE,
  endsWithArg,
  isLegacyRef,
  markThen,
  ralphHome,
  refPrefix,
  sortRefs,
} from "../paths.ts";
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
ralph.out, which \`start\` leaves beside it, holds only a crash of bun's own.
`;

const HOME = ralphHome();
const out = (s: string) => process.stdout.write(s);
// A reader that has read enough closes the pipe: `head -1`, `grep -q`, a pager
// the human quits. Bun reports that as an error event on stdout, and with
// nobody listening it was an uncaught error: a stack trace and exit status 1,
// so `ralph status | grep -q running` under pipefail called a running loop not
// running. The event comes on a later tick than the write, so a command that
// runs to its end without waiting has finished by then, `die` included, and the
// 0 here is the status it would have had. A command that waits is ended at its
// next wait, so one that prints before its work is done would lose the rest:
// print when the work is done, as `start` and `stop` do.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});
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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A program the human works in on this terminal, run to its end: its exit
 * status, or 127 when it could not be started. A spawn that fails reports it
 * as an error event, and with no listener bun printed that as a crash and then
 * never exited, so the CLI held the terminal until the human killed it.
 */
function attached(argv: string[], opts: SpawnOptions = {}): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn(argv[0]!, argv.slice(1), { stdio: "inherit", ...opts });
    c.once("error", () => resolve(127));
    c.once("exit", (code) => resolve(code ?? 128));
  });
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

/**
 * A PID is not an identity. ralph.pid outlives a `kill -9`, the OOM killer and
 * a reboot, and after a reboot the kernel hands those low numbers straight back
 * out: `kill -0` then says "running" about a stranger, and `ralph stop` would
 * TERM and then KILL that stranger's whole process group. `ralph start` puts
 * this loop's directory at the end of the loop's command line, so the loop is
 * the process whose command line ends with it, and nothing else counts. A
 * literal match: a path is not a pattern.
 *
 * ralph.pid is the PID `ralph start` spawned, and ralph.lock the one the loop
 * wrote itself once it had passed its checks. Two starts at once both write
 * ralph.pid, and the last one written can be the loop the lock refused, so the
 * loop that runs was once "stopped" to `ralph status` and "not running" to
 * `ralph stop`. Either file can name the loop.
 */
function pidOf(dir: string, bashToo = false): string | null {
  for (const file of ["ralph.pid", "ralph.lock"]) {
    const pid = read(join(dir, file)).trim();
    if (!/^\d+$/.test(pid) || !alive(Number(pid))) continue;
    dbg(`pidOf ${file} ${pid}: commandLineSync begin`);
    const cmd = commandLineSync(pid);
    dbg(`pidOf: commandLineSync end`);
    if (!endsWithArg(cmd, dir)) continue;
    if (markThen(cmd, LOOP_MARK)) return pid;
    // The bash harness this replaced ran `bash <harness>/ralph.sh <dir>`.
    if (bashToo && cmd.includes("ralph") && cmd.includes(".sh ")) return pid;
  }
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
  const str = (k: string, d: string) => (typeof raw[k] === "string" ? raw[k] : d);
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
  const up = upTimeSync(pid);
  return `\x1b[32mrunning\x1b[0m  PID ${pid}  up ${up}`;
}

/**
 * Under a stopped loop, what its last run left running when it was killed
 * outright: the agent goes on unbounded, and "stopped" alone gave nobody a
 * reason to run the `ralph stop` that ends it. Asks, never stops.
 */
function leftOver(dir: string): void {
  if (pidOf(dir)) return;
  const pid = orphanSync(join(dir, CHILD_FILE));
  if (pid === null) return;
  out(
    `  \x1b[33mleft over   PID ${pid}, which its last run left running when it died, is still running — stop it: ${hint("ralph", "stop", basename(dir))}\x1b[0m\n`,
  );
}

/**
 * The loop rotates its log, so the history is spread over ralph.log and the
 * ralph.log.N behind it. Anything that reads the log reads them all, oldest
 * first — numerically, because ralph.log.10 sorts under ralph.log.2 by name.
 */
function logFiles(dir: string): string[] {
  let names: string[];
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
  leftOver(dir);
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
  if (!isCheckout(repo)) die(`not a git checkout: ${repo}`);
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
    if (JSON.stringify(got) !== JSON.stringify(value))
      die(`--set ${key} did not reach config.json: it reads back as ${JSON.stringify(got)}`);
  }
  // The loop would refuse to start on it, so it is not a scaffold either.
  const push = pushProblem(back.config);
  if (push) {
    die(
      `${push} — add ${hint("--set", `PUSH_CONFIRM=${back.config.BRANCH}`)} to mean it, or ${hint("--set", "PUSH=pr")} to land through a pull request; nothing was created`,
    );
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
function dbg(m: string): void {
  if (process.platform !== "win32") return;
  try {
    mkdirSync("C:\\ralph-debug", { recursive: true });
    appendFileSync("C:\\ralph-debug\\start.log", `${new Date().toISOString()} cli=${process.pid} ${m}\n`);
  } catch {}
}
process.on("exit", (c) => dbg(`exit ${c}`));

function booted(dir: string, pid: number, exited: () => boolean): boolean {
  return exited() || !alive(pid) || read(join(dir, "ralph.lock")).trim() === String(pid);
}

/** The loop has done its whole start, the worktree and SETUP_CMD included, and runs. */
function started(dir: string, pid: number): boolean {
  return read(join(dir, STARTED_FILE)).trim() === String(pid);
}

// Now and then bun on Linux never finishes loading the loop's modules: the
// process sits in epoll with no child and no line of its own written, and a
// loop that `ralph status` calls running does nothing for ever. So a start is
// not believed until the loop has run its first lines. One that has not within
// BOOT_WAIT seconds is killed and started again, a few times, and ralph.log
// says so.
const BOOT_WAIT = Number(process.env.RALPH_TEST_BOOT_WAIT) || 30;
const BOOT_TRIES = 3;

/**
 * The loop exited before its start was done: a setting it could not read, a
 * file missing, another loop holding the lock, a worktree it could not make or
 * a SETUP_CMD that failed. It says why in ralph.log, in its own lines since
 * `from` (bytes), and a loop that runs is the reason when there is one.
 * "started <name>" in green, exit status 0, is what this printed for every
 * refusal there is, and the loop was gone before the human read it.
 */
function notStarted(dir: string, name: string, pid: number, from: number): never {
  if (read(join(dir, "ralph.pid")).trim() === String(pid)) rmSync(join(dir, "ralph.pid"), { force: true });
  dbg(`notStarted: pidOf begin`);
  const other = pidOf(dir);
  dbg(`notStarted: pidOf end ${other}`);
  if (other) die(`already running as PID ${other}`);
  let text = "";
  try {
    const all = readFileSync(join(dir, "ralph.log"));
    text = all.subarray(all.length >= from ? from : 0).toString("utf8");
  } catch {}
  const said = splitLines(text)
    .filter((l) => /^\[[^\]]*\] /.test(l))
    .map((l) => `\n  ${l.slice(l.indexOf("] ") + 2)}`);
  die(`${name} did not start:${said.join("") || ` see ${join(dir, "ralph.log")}`}`);
}

async function cmdStart(name?: string): Promise<void> {
  const dir = loopDir(name);
  if (!isDir(dir)) die(`no such loop: ${name}`);
  if (loopKind(dir) === "sh") die(`${name} keeps its settings in config.sh — convert them first: ${hint("ralph", "migrate", name!)}`);
  const running = pidOf(dir);
  if (running) die(`already running as PID ${running}`);
  const log = new Log(join(dir, "ralph.log"));
  for (let attempt = 1; ; attempt++) {
    const from = log.size();
    // Not stdout: every line the loop logs goes there too, for a loop run by
    // hand in a terminal, and here that made ralph.out a second ralph.log that
    // nothing rotates. stderr is what bun says on its own, a crash, in no log.
    const fd = openSync(join(dir, "ralph.out"), "a");
    const child = spawn(process.execPath, [LOOP_ENTRY, dir], { detached: true, windowsHide: true, stdio: ["ignore", "ignore", fd] });
    closeSync(fd);
    child.unref();
    const pid = child.pid!;
    let status: number | null | undefined;
    const ended = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    void ended.then((code) => (status = code));
    const exited = () => status !== undefined;
    writeFileSync(join(dir, "ralph.pid"), `${pid}\n`);
    dbg(`spawned ${pid} for ${name} attempt ${attempt}`);
    for (let waited = 0; waited < BOOT_WAIT * 10 && !booted(dir, pid, exited); waited++) await Bun.sleep(100);
    dbg(`boot wait over: booted=${booted(dir, pid, exited)} exited=${exited()} alive=${alive(pid)}`);
    if (booted(dir, pid, exited)) {
      // The lock is not the end of a start: the worktree and SETUP_CMD come
      // after it, and a loop that refuses one of them is gone a moment later.
      // Wait BOOT_WAIT seconds more for the loop to say its start is done; a
      // long SETUP_CMD outlasts that, and then the line below says so.
      const gone = () => exited() || !alive(pid);
      for (let waited = 0; waited < BOOT_WAIT * 10 && !started(dir, pid) && !gone(); waited++) await Bun.sleep(100);
      if (!started(dir, pid) && gone()) {
        // Gone and reaped, so its exit status is on its way.
        dbg(`gone: exited=${exited()} alive=${alive(pid)} started=${started(dir, pid)}`);
        if (!exited()) status = await ended;
        dbg(`await ended returned ${status}`);
        notStarted(dir, name!, pid, from);
      }
      green(`started ${name} as PID ${pid}`);
      if (!started(dir, pid)) {
        dim(
          `  still starting after ${BOOT_WAIT}s (a new worktree runs SETUP_CMD first), so it can still fail: ${hint("ralph", "tail", name!)}`,
        );
      }
      dim(`  ${hint("ralph", "status", name!)}   ${hint("ralph", "tail", name!)}   ${hint("ralph", "stop", name!)}`);
      return;
    }
    killTree(pid);
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
  if (!pid) {
    // A loop killed outright (kill -9, the OOM killer, bun crashing) runs no
    // handler, and its agent goes on in a group of its own with nothing left to
    // bound it, ITER_TIMEOUT included. This said "not running" and left it
    // writing into the checkout until the next `ralph start`.
    const orphan = await reapOrphan(join(dir, CHILD_FILE));
    if (orphan === null) die(`${name} is not running`);
    const said = `PID ${orphan}, which its last run left running when it died, was still running; stopped it and its process group`;
    // The file alone: Log.line writes to stdout too, which is the line below.
    new Log(join(dir, "ralph.log")).raw(`[${stamp()}] ralph stop: ${said}\n`);
    green(`${name} was not running, but ${said}`);
    return;
  }
  // TERM lets the loop take down the agent's whole process group (tests, dev
  // servers, MCP servers) and log where it stopped. That can take a few
  // seconds, so wait before reaching for SIGKILL. Windows has no TERM, so
  // there the loop is asked through a file it watches for.
  if (IS_WIN) {
    writeFileSync(join(dir, STOP_FILE), "");
  } else {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {}
  }
  for (let i = 0; i < 15 && alive(Number(pid)); i++) await Bun.sleep(1000);
  if (alive(Number(pid)) && IS_WIN) {
    // The loop and its whole tree: the agent is in it.
    killTree(Number(pid));
  } else if (alive(Number(pid))) {
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
  rmSync(join(dir, STOP_FILE), { force: true });
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

/**
 * The [n] of `log`, `results` and `review`: a whole number of 1 or more, or
 * the command refuses. parseInt read `-50` (tail's habit) as -50, so the
 * command printed nothing and review said "nothing yet" over shipped commits;
 * `1e3` as 1; `0` and `abc` as the default. Every one of them exited 0.
 */
function count(cmd: string, arg: string | undefined, fallback: number): number {
  if (arg === undefined) return fallback;
  if (!/^\d+$/.test(arg) || Number(arg) < 1)
    die(`n is how many to show, a whole number of 1 or more, not ${JSON.stringify(arg)} — usage: ralph ${cmd} <name> [n]`);
  return Number(arg);
}

function cmdLog(name?: string, nArg?: string): void {
  const k = count("log", nArg, 40);
  const dir = loopDir(name);
  const files = logFiles(dir);
  if (!files.length) die(`no log yet for ${name}`);
  const all = splitLines(files.map(read).join(""));
  out(
    all
      .slice(Math.max(0, all.length - k))
      .map((l) => `${l}\n`)
      .join(""),
  );
}

async function cmdTail(name?: string): Promise<void> {
  const dir = loopDir(name);
  if (IS_WIN) return follow(join(dir, "ralph.log"));
  // -F, not -f: a rotation renames the file this is following, and -f would
  // then sit on the old one, silent, for the rest of the run.
  await attached(["tail", "-F", join(dir, "ralph.log")]);
}

/**
 * `tail -F` for Windows, which has no tail: the last ten lines, then whatever is
 * appended. A rotation is told by the file's identity, not by its size: the
 * new ralph.log can grow past the old offset between two looks, and read from
 * there it would lose its first lines. The identity is a bigint because NTFS
 * file ids do not fit in a double.
 */
async function follow(file: string): Promise<never> {
  const id = () => {
    try {
      return statSync(file, { bigint: true }).ino;
    } catch {
      return null;
    }
  };
  let ino = id();
  const text = read(file);
  out(
    splitLines(text)
      .slice(-10)
      .map((l) => `${l}\n`)
      .join(""),
  );
  let pos = Buffer.byteLength(text);
  for (;;) {
    await Bun.sleep(500);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    const now = id();
    if (now !== ino || size < pos) {
      ino = now;
      pos = 0;
    }
    if (size === pos) continue;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(size - pos);
    readSync(fd, buf, 0, buf.length, pos);
    closeSync(fd);
    process.stdout.write(buf);
    pos = size;
  }
}

/**
 * What a loop did, for a human deciding what to keep: verdict counts, the
 * commits it shipped, the ones the gates threw away (kept under refs/ralph/),
 * and, when it does not push, what is waiting on ralph/<name> to be merged.
 */
function cmdReview(name?: string, nArg?: string): void {
  const n = count("review", nArg, 10);
  const dir = loopDir(name);
  if (!existsSync(join(dir, "config.json"))) {
    if (existsSync(join(dir, "config.sh")))
      die(`${name} keeps its settings in config.sh — convert them first: ${hint("ralph", "migrate", name!)}`);
    die(`no loop called ${name} in ${HOME}`);
  }
  const c = loopConf(dir);
  if (!c.work || git(c.work, "rev-parse", "--git-dir").code !== 0) die(`cannot read the repository at ${c.work}`);
  let where = `works in ${c.repo}`;
  if (c.worktree) {
    where = `works on ralph/${name} in ${c.work}`;
    if (c.push === true) where += `, pushes to origin/${c.branch}`;
    else if (c.push === "pr")
      where += `, pushes it for a pull request into ${c.branch}${c.merge ? ", and merges that when the loop ends if its checks pass" : ""}`;
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
  // Only this loop's: the refs belong to the repository, which other loops
  // may share. The ones an older version kept name no loop, so they get a
  // heading of their own, and only when there are any.
  const listRefs = (refs: string[]): number => {
    let listed = 0;
    for (const ref of sortRefs(refs).slice(0, n)) {
      const l = git(c.work, "log", "-1", `--format=  %h  %s  (${ref.slice("refs/".length)})`, ref);
      if (l.code === 0) {
        out(l.out);
        listed++;
      }
    }
    return listed;
  };
  const refsOf = (...prefixes: string[]) => splitLines(git(c.work, "for-each-ref", "--format=%(refname)", ...prefixes).out);
  out(`\nReverted or dropped by the gates, kept under refs/ralph/${name}/\n`);
  if (!listRefs(refsOf(refPrefix(name!, "reverted"), refPrefix(name!, "dropped")))) dim("  nothing");
  const legacy = refsOf(...LEGACY_REFS).filter(isLegacyRef);
  if (legacy.length) {
    out("\nKept under refs/ralph/ by an older version, for any loop on this repository\n");
    listRefs(legacy);
  }

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

function cmdResults(name?: string, nArg?: string): void {
  const n = count("results", nArg, 20);
  const dir = loopDir(name);
  const file = join(dir, "results.tsv");
  if (!existsSync(file)) die(`no results yet for ${name}`);
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
  if (!/\S/.test(text)) die('usage: ralph steer <name> "what to do instead"');
  // One list item however many lines the text has: its later lines indented
  // under the first, so none of them can be a heading of PROMPT.md. A `## Why`
  // in the text once ended the Steering section, and the reviewer's brief,
  // which takes that section up to the next heading, lost the rest of it.
  const said = text.split(/\r?\n/);
  while (!/\S/.test(said[0]!)) said.shift();
  while (!/\S/.test(said.at(-1)!)) said.pop();
  const entry = said.map((l, i) => (i === 0 ? l : /\S/.test(l) ? `  ${l}` : "")).join("\n");
  const dir = loopDir(name);
  const promptFile = join(dir, "PROMPT.md");
  if (!existsSync(promptFile)) die(`no such loop: ${name}`);
  const MARK = "<!-- ralph-steer -->";
  // The marker is what makes this repeatable: entries always land directly
  // under it, newest first, without re-parsing the prose around them.
  if (!read(promptFile).includes(MARK)) {
    appendFileSync(
      promptFile,
      `\n## Steering\n\nAdded while the loop was running, newest first. These outrank the backlog below.\n\n${MARK}\n`,
    );
  }
  const lines: string[] = [];
  let seen = false;
  for (const line of splitLines(read(promptFile))) {
    lines.push(line);
    if (!seen && line.includes(MARK)) {
      lines.push("", `- [${stampMinutes()}] ${entry}`);
      seen = true;
    }
  }
  rewrite(promptFile, lines.map((l) => `${l}\n`).join(""));
  appendFileSync(join(dir, "STEER.md"), `${text}\n`);
  green(`steered ${name} — the running iteration sees it at its next tool call, and every later one reads it from PROMPT.md`);
}

/** Claude Code in the current directory, with the ralph-new skill from this checkout loaded. */
async function cmdSetup(): Promise<never> {
  const claude = Bun.which("claude");
  if (!claude) die("claude is not on PATH — install Claude Code first: https://code.claude.com");
  const problem = claudeProblem();
  if (problem) die(problem);
  const skill = join(HARNESS, "skills/ralph-new/SKILL.md");
  const prompt = `Set up a ralph loop on the repository in this directory, following the ralph-new instructions in your system prompt. The ralph CLI is ${join(HARNESS, "bin/ralph")}.`;
  process.exit(await attached([claude, "--append-system-prompt-file", skill, prompt], { cwd: process.cwd() }));
}

/**
 * PROMPT.md in the human's editor. EDITOR is shell text, as git and every other
 * tool that reads it takes it: `code --wait` and `emacsclient -t` are a program
 * and its flags, and spawned as the name of one program they never started.
 * bash reads the text from the environment under a constant script, and the
 * file goes there too, so the loop's path is never part of a command line. The
 * default, and an EDITOR that is the path of a program, are that program, as
 * they always were: a shell would split a path at a space and, on Windows, eat
 * its backslashes.
 */
async function cmdEdit(name?: string): Promise<void> {
  const file = join(loopDir(name), "PROMPT.md");
  if (!existsSync(file)) die(`no loop called ${name} in ${HOME}`);
  const editor = process.env.EDITOR || (IS_WIN ? "notepad" : "vi");
  let code: number;
  if (!process.env.EDITOR || (/[\\/]/.test(editor) && isFile(editor))) {
    code = await attached([editor, file]);
  } else {
    const sh = shellCommand(`eval "$RALPH_EDITOR"' "$RALPH_EDIT_FILE"'`);
    code = await attached(sh.argv, { env: { ...process.env, ...sh.env, RALPH_EDITOR: editor, RALPH_EDIT_FILE: file } });
  }
  if (code !== 0) die(`the editor, ${JSON.stringify(editor)}, exited ${code}`);
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
    else if (orphanSync(join(dir, CHILD_FILE)) !== null) flags.push("stopped, but left a process running");
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
    out(`ralph ${(JSON.parse(readFileSync(join(HARNESS, "package.json"), "utf8")) as { version: string }).version}\n`);
    break;
  default:
    die(`unknown command: ${cmd} (try: ralph help)`);
}
