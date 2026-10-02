import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_RATE_LIMIT_RE } from "../../src/lib/config.ts";
import { type Migrated, migrate } from "../../src/cli/migrate.ts";

// The oracle for `ralph migrate` is bash itself: source the config.sh the way
// the old harness did, and read back what each setting became. The converter
// is right when the loop reads the same values from config.json.
const T = mkdtempSync(join(tmpdir(), "ralph-unit-migrate."));
const ORACLE = `f="$1"; shift; keys=("$@")
RATE_LIMIT_RE="$DEFAULT_RE"
. "$f" >/dev/null 2>&1
for k in "\${keys[@]}"; do
  d="$(declare -p "$k" 2>/dev/null)"
  case "$d" in
    "declare -a"*) eval 'v=("\${'"$k"'[@]}")'; printf '%s\\0a\\0%s\\0' "$k" "\${#v[@]}"
                   if [ "\${#v[@]}" -gt 0 ]; then printf '%s\\0' "\${v[@]}"; fi ;;
    "") ;;
    *) printf '%s\\0s\\0%s\\0' "$k" "\${!k}" ;;
  esac
done`;

type Seen = Record<string, string | string[]>;

function sourced(text: string, keys: string[]): Seen {
  const f = join(T, `config.${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(f, text);
  const r = Bun.spawnSync(["bash", "-c", ORACLE, "_", f, ...keys], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DEFAULT_RE: DEFAULT_RATE_LIMIT_RE },
  });
  const parts = r.stdout.toString().split("\0");
  const out: Seen = {};
  let i = 0;
  while (i < parts.length - 1) {
    const k = parts[i++]!;
    const kind = parts[i++]!;
    if (kind === "a") {
      const n = Number(parts[i++]);
      out[k] = parts.slice(i, i + n);
      i += n;
    } else {
      out[k] = parts[i++]!;
    }
  }
  return out;
}

/** What config.json says, as bash would have held it. */
function asBash(v: unknown): string | string[] {
  if (Array.isArray(v)) return v as string[];
  if (v === true) return "1";
  if (v === false) return "0";
  return String(v);
}

function agrees(text: string): void {
  const m = migrate(text, "x");
  if (!m.ok) throw new Error(m.error);
  const keys = Object.keys(m.config).filter((k) => k !== "RATE_LIMIT_EXTRA_RE");
  const extends_ = "RATE_LIMIT_EXTRA_RE" in m.config;
  const want = sourced(text, extends_ ? [...keys, "RATE_LIMIT_RE"] : keys);
  for (const k of keys) expect([k, asBash(m.config[k])]).toEqual([k, want[k]!]);
  if (extends_) expect(`${DEFAULT_RATE_LIMIT_RE}|${m.config.RATE_LIMIT_EXTRA_RE as string}`).toBe(want.RATE_LIMIT_RE as string);
}

/** Refused, or read as bash read it. What the converter must never do is write something else. */
function refusesOrAgrees(text: string): void {
  if (migrate(text, "x").ok) agrees(text);
}

describe("ralph migrate reads config.sh the way bash did", () => {
  test("plain assignments, several to a line, with comments", () => {
    agrees(`# Settings for the x loop.
REPO="/Users/x/code/app"
MAX_ITER=40
QUIET_STOP=3 QUIET_SLEEP=0 STEP_SLEEP=0   # no waiting
MODEL=opus
WORKTREE=1
REVIEW=0
PUSH=pr
BRANCH="feat/evals-results"
`);
  });
  test("a path shell-quoted the way ralph new wrote it", () => {
    agrees("REPO=/Users/x/r\\&d\\ app\n");
    agrees("REPO='/Users/x/it'\\''s here'\n");
  });
  test("lists, on one line or several, quoted or bare", () => {
    agrees(`ADD_DIRS=("/Users/x/.claude/plans" "/private/tmp/scratch pad")
FROZEN=("packages" ".github" "apps/storybook" "tokens")
DENY=("Bash(gh *)" "Bash(git push *)")
CHURN_IGNORE=(
  "CHANGELOG.md"   # the changelog
  docs/generated
)
FROZEN=()
`);
  });
  test("commands, with && chains and an environment prefix", () => {
    agrees(`VERIFY_CMD="yarn lint && DOCS_TURBOPACK_ROOT=/ yarn build:docs"
SETUP_CMD="bash /Users/x/.claude/ralph/freshfiled/setup.sh"
HEALTH_CMD="echo \\"quoted\\" and a \\\\ backslash and a \\$ sign"
`);
  });
  test("the DONE_CMD with a bracket class", () => {
    agrees(`DONE_CMD='test -f docs/milestones.md && ! grep -q "^- \\[ \\]" docs/milestones.md'\n`);
  });
  test("the osascript NOTIFY_CMD with its '\\'' quoting", () => {
    agrees(
      `NOTIFY_CMD='osascript -e '\\''display notification (system attribute "RALPH_MESSAGE") with title ("ralph: " & (system attribute "RALPH_LOOP")) subtitle (system attribute "RALPH_EVENT")'\\'''\n`,
    );
  });
  test("an extended limit pattern becomes RATE_LIMIT_EXTRA_RE", () => {
    agrees(`RATE_LIMIT_RE="$RATE_LIMIT_RE|quota window closed"\n`);
    agrees(`RATE_LIMIT_RE="$RATE_LIMIT_RE"'|our gateway says no'\n`);
    const m = migrate(`RATE_LIMIT_RE="$RATE_LIMIT_RE|quota window closed"\n`, "x");
    expect(m.ok && m.config).toEqual({ RATE_LIMIT_EXTRA_RE: "quota window closed" });
  });
  test("a line continued with a backslash", () => {
    agrees('VERIFY_CMD="npm test \\\n  --silent"\n');
  });
  test("a list continued with backslashes, a word to a line", () => {
    agrees("FROZEN=(\n  measure.sh \\\n  tests/eval \\\n)\nCHURN_IGNORE=(a \\\n  b)\nVERIFY_CMD=x \\\nMAX_ITER=3\n");
  });
  test("a brace, a ~ or a backslash where bash keeps it as it is", () => {
    agrees('VERIFY_CMD=x{a,b}\nFROZEN=(a\\{b,c} \'{d,e}\' a:~/b a=~/b a~b "~/c" ""~/d)\n');
    agrees("SETUP_CMD=a:\"~\"/b HEALTH_CMD=a\\:~/b DONE_CMD=a=~/b NOTIFY_CMD=a:''~/b\n");
    agrees("VERIFY_CMD=a\\");
  });
  test("a scalar in a list setting is a list of one", () => {
    const m = migrate("FROZEN=measure.sh\n", "x");
    expect(m.ok && m.config.FROZEN).toEqual(["measure.sh"]);
  });
  test("the output is config.json the loop reads, with a header saying where it came from", () => {
    const m = migrate('REPO="/r"\nMAX_ITER=7\n', "demo");
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.json).toContain('converted by "ralph migrate" from config.sh.old');
    expect(Bun.JSONC.parse(m.json)).toMatchObject({ REPO: "/r", MAX_ITER: 7 });
    expect((Bun.JSONC.parse(m.json) as { $schema: string }).$schema).toMatch(/^file:\/\/.*template\/config\.schema\.json$/);
  });
});

describe("ralph migrate refuses what it would have to evaluate", () => {
  const refused: [string, string][] = [
    ['REPO="$HOME/app"\n', "$ expansion"],
    ["REPO=$HOME/app\n", "$ expansion"],
    ["MAX_ITER=`echo 3`\n", "command substitution"],
    ["MAX_ITER=$((1+2))\n", "$ expansion"],
    ["CLOSING=$'a\\nb'\n", "$'…'"],
    ["ADD_DIRS+=(x)\n", "+="],
    ["export MAX_ITER=3\n", "not a setting"],
    ["[ -d x ] && ADD_DIRS=(x)\n", "not a setting"],
    ["FOO=1\n", "FOO is not a setting"],
    ["FROZEN=(*.md)\n", "glob"],
    ["FROZEN=(src/{eval,score}.ts)\n", "brace"],
    ["REPO=~/app\n", "~"],
    ["VERIFY_CMD=PATH=/opt/bin:~/bin\n", "a ~ that bash would have expanded"],
    ["VERIFY_CMD=\\\n~/bin/check\n", "a ~ that bash would have expanded"],
    ["FROZEN=(a)#b\n", '"#" right after the ) that closes a list'],
    ["MAX_ITER=forty\n", "not a whole number"],
    ["WORKTREE=yes\n", "not 0 or 1"],
    ["PUSH=main\n", "not 0, 1 or pr"],
    ['REPO="/r\n', "never closes"],
    ["REPO=relative/path\n", "absolute path"],
  ];
  for (const [text, why] of refused) {
    test(`${JSON.stringify(text.trim())}: ${why}`, () => {
      const m = migrate(text, "x");
      expect(m.ok).toBe(false);
      if (!m.ok) expect(m.error).toContain(why);
    });
  }
  test("a ; inside a list is refused, not read for ever", () => {
    // The list reader once stood still on the ; and pushed "" until memory ran
    // out (8.5 GB in 8s), so these run in a child that is killed after 10s.
    const texts = ["FROZEN=(measure.sh;tests)\n", "FROZEN=(a ;)\n", "FROZEN=(;)\n"];
    const url = pathToFileURL(join(import.meta.dir, "../../src/cli/migrate.ts")).href;
    const code = `const { migrate } = await import(${JSON.stringify(url)});
console.log(JSON.stringify(JSON.parse(await Bun.stdin.text()).map((t) => migrate(t, "x"))));`;
    const r = Bun.spawnSync([process.execPath, "-e", code], { stdin: Buffer.from(JSON.stringify(texts)), timeout: 10_000 });
    expect(r.exitCode).toBe(0);
    for (const m of JSON.parse(r.stdout.toString()) as Migrated[]) expect(!m.ok && m.error).toContain("shell syntax");
  });
  test("the refusal quotes the line it is about", () => {
    const m = migrate('MAX_ITER=3\nREPO="$HOME/app"\n', "x");
    expect(!m.ok && m.error).toContain('REPO="$HOME/app"');
  });
});

// Each of these is a line bash read as something other than the plain text on
// it — a brace or a ~ it expanded, a line continuation it joined, a list it took
// for one word — or could not read at all. The converter refuses each, or
// writes what bash held; a value nobody wrote is the one wrong answer.
describe("ralph migrate never writes a value bash did not hold", () => {
  const odd = [
    "FROZEN=(src/{eval,score}.ts measure.sh)\n",
    "FROZEN=({a..c})\n",
    "FROZEN=(a\\\n{b,c})\n",
    "VERIFY_CMD=PATH=/opt/bin:~/bin\n",
    'VERIFY_CMD="a":~/b\n',
    "VERIFY_CMD=a:\\\n~/b\n",
    "VERIFY_CMD=\\\n~/bin/check\n",
    "FROZEN=(\\\n~/a)\n",
    "FROZEN=(a)#b\n",
    "FROZEN=(a)b\n",
    "FROZEN=(a b)\\\n",
    "FROZEN=(a)\r\nMAX_ITER=3\r\n",
    "FROZEN=(a \\\n  b)\n",
    "VERIFY_CMD=a\\",
  ];
  for (const text of odd) test(JSON.stringify(text), () => refusesOrAgrees(text));
});
