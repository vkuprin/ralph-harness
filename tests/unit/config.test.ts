import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RATE_LIMIT_RE, KEYS, checkSetting, defaults, limitPattern, parseConfig, pushProblem, schema } from "../../src/lib/config.ts";

const parse = (text: string) => parseConfig(text, "config.json", "/loops/x");
const ok = (text: string) => {
  const r = parse(text);
  if (!r.ok) throw new Error(r.error);
  return r.config;
};
const err = (text: string) => {
  const r = parse(text);
  if (r.ok) throw new Error("parsed");
  return r.error;
};

describe("config.json", () => {
  test("a key left out takes the harness default, not the template's", () => {
    const c = ok('{ "REPO": "/r" }');
    expect(c).toEqual({ ...defaults("/loops/x"), REPO: "/r" });
    expect(c.WORKTREE).toBe(false);
    expect(c.PUSH).toBe(false);
    expect(c.REVIEW).toBe(false);
    expect(c.CHURN_AT).toBe(0);
    expect(c.LIMIT_RESET).toBe(false);
    expect(c.PR_MERGE).toBe(false);
  });
  test("the default closing line names this loop's PROGRESS.md", () => {
    expect(ok("{}").CLOSING).toContain(join("/loops/x", "PROGRESS.md"));
  });
  test("comments and trailing commas are fine", () => {
    expect(ok('// a loop\n{\n  "MAX_ITER": 3, // three\n  /* and */ "FROZEN": ["a",],\n}').MAX_ITER).toBe(3);
  });
  test("a file that does not parse is refused, with the parser's reason", () => {
    expect(err('{ "REPO": "/r",\n  if [ 1 ; then\n}')).toMatch(/config\.json does not parse: \S/);
  });
  test("a file that is not an object is refused", () => {
    expect(err("[1, 2]")).toContain("does not parse");
  });
  test("an unknown key is refused rather than ignored", () => {
    expect(err('{ "MAX_ITERS": 3 }')).toContain("MAX_ITERS is not a setting");
  });
  test("a value of the wrong type is refused", () => {
    expect(err('{ "MAX_ITER": "40" }')).toContain("MAX_ITER must be a whole number");
    expect(err('{ "MAX_ITER": 4.5 }')).toContain("whole number");
    expect(err('{ "WORKTREE": "yes" }')).toContain("true or false");
    expect(err('{ "FROZEN": "a" }')).toContain("a list of strings");
    expect(err('{ "PUSH": "main" }')).toContain('"pr"');
    expect(err('{ "VERIFY_CMD": 1 }')).toContain("a string");
  });
  test("REPO and WORKTREE_DIR must be absolute", () => {
    expect(err('{ "REPO": "code/app" }')).toContain("absolute path");
    expect(err('{ "WORKTREE_DIR": "../wt" }')).toContain("absolute path");
    expect(ok('{ "WORKTREE_DIR": "" }').WORKTREE_DIR).toBe("");
  });
  test("0 and 1 are read as false and true, the way config.sh wrote them", () => {
    expect(ok('{ "WORKTREE": 1, "REVIEW": 0 }')).toMatchObject({ WORKTREE: true, REVIEW: false });
    expect(ok('{ "PUSH": 1 }').PUSH).toBe(true);
    expect(ok('{ "PUSH": "pr" }').PUSH).toBe("pr");
  });
  test("PR_MERGE_METHOD is one of the three merges GitHub knows", () => {
    expect(ok('{ "PR_MERGE_METHOD": "squash" }').PR_MERGE_METHOD).toBe("squash");
    expect(ok("{}").PR_MERGE_METHOD).toBe("merge");
    expect(err('{ "PR_MERGE_METHOD": "fast" }')).toContain('"merge", "squash" or "rebase"');
  });
  test("a setting given outside a file is judged the same way", () => {
    expect(checkSetting("PR_MERGE", 1)).toEqual({ ok: true, value: true });
    expect(checkSetting("PUSH", "pr")).toEqual({ ok: true, value: "pr" });
    expect(checkSetting("MAX_ITER", "3")).toEqual({ ok: false, error: 'MAX_ITER must be a whole number, not "3"' });
    expect(checkSetting("MAX_ITERS", 3)).toEqual({ ok: false, error: "MAX_ITERS is not a setting this harness knows" });
    // Not a key because every object has it.
    expect(checkSetting("toString", "x").ok).toBe(false);
  });
  test("a limit pattern that does not compile is refused", () => {
    expect(err('{ "RATE_LIMIT_EXTRA_RE": "(" }')).toContain("regular expression");
  });
  test("$schema is allowed", () => {
    expect(ok('{ "$schema": "./config.schema.json" }').MAX_ITER).toBe(500);
  });
  test("the limit pattern: the default, a replacement, or the default extended", () => {
    expect(limitPattern(ok("{}")).source).toBe(new RegExp(DEFAULT_RATE_LIMIT_RE).source);
    expect(limitPattern(ok('{ "RATE_LIMIT_RE": "only this" }')).test("ONLY THIS")).toBe(true);
    const ext = limitPattern(ok('{ "RATE_LIMIT_EXTRA_RE": "quota window closed" }'));
    expect(ext.test("our proxy says: quota window closed")).toBe(true);
    expect(ext.test("You've hit your limit")).toBe(true);
  });
  test("the template parses once its repo is filled in, and sets only known keys", () => {
    const tpl = readFileSync(join(import.meta.dir, "../../template/config.json"), "utf8");
    const c = ok(tpl.split('"__REPO_JSON__"').join(JSON.stringify("/code/app")).split('"__SCHEMA_JSON__"').join('"x"'));
    expect(c.REPO).toBe("/code/app");
    expect(c.WORKTREE).toBe(true);
    expect(c.NOTIFY_CMD).toBe("");
    expect(c.PR_MERGE).toBe(false);
  });
  test("the schema in template/ is the one the harness would write, and names every setting", () => {
    const committed = readFileSync(join(import.meta.dir, "../../template/config.schema.json"), "utf8");
    expect(committed).toBe(`${JSON.stringify(schema(), null, 2)}\n`);
    expect(Object.keys((schema() as { properties: object }).properties).filter((k) => k !== "$schema")).toEqual(KEYS);
  });
});

describe("pushProblem: PUSH true names its branch", () => {
  const c = (over: Record<string, unknown>) => ({ ...defaults("/l"), WORKTREE: true, ...over }) as ReturnType<typeof defaults>;
  test("PUSH true without PUSH_CONFIRM is a problem", () => {
    expect(pushProblem(c({ PUSH: true }))).toContain("straight to origin/main");
  });
  test("PUSH_CONFIRM naming BRANCH settles it", () => {
    expect(pushProblem(c({ PUSH: true, PUSH_CONFIRM: "main" }))).toBeNull();
    expect(pushProblem(c({ PUSH: true, BRANCH: "dev", PUSH_CONFIRM: "dev" }))).toBeNull();
  });
  test("naming another branch does not: a later change of BRANCH is confirmed again", () => {
    expect(pushProblem(c({ PUSH: true, BRANCH: "main", PUSH_CONFIRM: "dev" }))).toContain('names "dev", not BRANCH "main"');
  });
  test("nothing else needs it", () => {
    expect(pushProblem(c({ PUSH: "pr" }))).toBeNull();
    expect(pushProblem(c({ PUSH: false }))).toBeNull();
    // Without a worktree the harness pushes nothing.
    expect(pushProblem(c({ PUSH: true, WORKTREE: false }))).toBeNull();
  });
});
