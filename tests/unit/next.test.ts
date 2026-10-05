import { describe, expect, test } from "bun:test";
import { nextName } from "../../src/loop/next.ts";

describe("nextName", () => {
  test("a plain name is that loop", () => {
    expect(nextName("site-polish", "site-build")).toEqual({ name: "site-polish" });
  });
  test("{n+1} counts from this loop's number", () => {
    expect(nextName("polish-{n+1}", "polish-3")).toEqual({ name: "polish-4" });
    expect(nextName("r{n+1}-polish", "r9-polish")).toEqual({ name: "r10-polish" });
    expect(nextName("polish-{n+1}", "polish-09")).toEqual({ name: "polish-10" });
    expect(nextName("polish-{n+1}", "polish-99999999999999999999")).toEqual({ name: "polish-100000000000000000000" });
  });
  test("characters a pattern would read are text", () => {
    expect(nextName("a.b+({n+1})", "a.b+(7)")).toEqual({ name: "a.b+(8)" });
    expect("problem" in nextName("a.b+({n+1})", "axb+(7)")).toBe(true);
  });
  test("a name that does not fit the template has no number", () => {
    expect(nextName("polish-{n+1}", "build")).toEqual({
      problem: "this loop's name, build, is not polish-<number>, so {n+1} has no number to count from",
    });
    expect("problem" in nextName("polish-{n+1}", "polish-")).toBe(true);
    expect("problem" in nextName("polish-{n+1}", "polish-2a")).toBe(true);
  });
  test("the counter goes in once", () => {
    expect(nextName("{n+1}-{n+1}", "1-1")).toEqual({ problem: "{n+1} goes in it once" });
  });
});
