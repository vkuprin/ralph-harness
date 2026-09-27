import { describe, expect, test } from "bun:test";
import { readChecks } from "../../src/loop/merge.ts";

const HEAD = "a".repeat(40);
const view = (rollup: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ url: "https://github.com/o/r/pull/7", state: "OPEN", headRefOid: HEAD, statusCheckRollup: rollup, ...extra });
const run = (name: string, conclusion: string, status = "COMPLETED") => ({ __typename: "CheckRun", name, status, conclusion });
const ctx = (context: string, state: string) => ({ __typename: "StatusContext", context, state });
const verdict = (text: string) => readChecks(text, HEAD).checks;

describe("the pull request's checks, as gh pr view reports them", () => {
  test("every check passed: success, neutral and skipped all count", () => {
    expect(verdict(view([run("test", "SUCCESS"), run("docs", "NEUTRAL"), run("deploy", "SKIPPED"), ctx("ci/legacy", "SUCCESS")]))).toEqual({
      verdict: "pass",
    });
  });
  test("its URL comes with it", () => {
    expect(readChecks(view([]), HEAD).url).toBe("https://github.com/o/r/pull/7");
  });
  for (const c of ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE", "failure"]) {
    test(`a check run that ended ${c} fails it`, () => {
      expect(verdict(view([run("test", "SUCCESS"), run("lint", c)]))).toEqual({ verdict: "fail", names: ["lint"] });
    });
  }
  test("a commit status of failure or error fails it, by its context", () => {
    expect(verdict(view([ctx("ci/a", "FAILURE"), ctx("ci/b", "ERROR")]))).toEqual({ verdict: "fail", names: ["ci/a", "ci/b"] });
  });
  test("a failure outranks a check still running", () => {
    expect(verdict(view([run("slow", "", "IN_PROGRESS"), run("lint", "FAILURE")]))).toEqual({ verdict: "fail", names: ["lint"] });
  });
  for (const [what, item] of [
    ["queued", run("test", "", "QUEUED")],
    ["in progress", run("test", "", "IN_PROGRESS")],
    ["completed with no conclusion yet", run("test", "")],
    ["a conclusion GitHub may add later", run("test", "SOMETHING_NEW")],
    ["a status still pending", ctx("test", "PENDING")],
    ["a status expected but not reported", ctx("test", "EXPECTED")],
  ] as const) {
    test(`a check ${what} is still running`, () => {
      expect(verdict(view([run("done", "SUCCESS"), item]))).toEqual({ verdict: "pending", names: ["test"] });
    });
  }
  test("no checks at all is its own answer, not a pass", () => {
    expect(verdict(view([]))).toEqual({ verdict: "none" });
    expect(verdict(view(null))).toEqual({ verdict: "none" });
    expect(verdict(JSON.stringify({ url: "", state: "OPEN", headRefOid: HEAD }))).toEqual({ verdict: "none" });
  });
  test("checks on another head say nothing about this one", () => {
    expect(verdict(view([run("test", "SUCCESS")], { headRefOid: "b".repeat(40) }))).toEqual({ verdict: "stale", seen: "b".repeat(40) });
  });
  test("a pull request already merged, or closed, says so before its checks", () => {
    expect(verdict(view([run("test", "FAILURE")], { state: "MERGED" }))).toEqual({ verdict: "merged" });
    expect(verdict(view([run("test", "SUCCESS")], { state: "CLOSED" }))).toEqual({ verdict: "closed" });
  });
  test("a notice gh printed around the JSON does not hide it", () => {
    expect(verdict(`A new release of gh is available\n${view([run("test", "SUCCESS")])}\n`)).toEqual({ verdict: "pass" });
  });
  test("anything else is unreadable, never a pass", () => {
    for (const t of ["", "not json", "[]", "null", '{"headRefOid":"x"', view({ not: "a list" })]) {
      expect(verdict(t).verdict).toBe("unreadable");
    }
    expect(verdict(view(["weird"]))).toEqual({ verdict: "pending", names: ["(unreadable check)"] });
  });
});
