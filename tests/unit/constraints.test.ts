import { describe, expect, test } from "bun:test";
import { appendEntry, expectedHard, isPlaceholder, readAdded, sameHard } from "../../src/loop/constraints.ts";

const PLACEHOLDER = "\n<One numbered line per constraint, each a pass/fail test.\nLeave this if there are none.>";

describe("isPlaceholder", () => {
  test("blank and the template's <...> are nothing set", () => {
    expect(isPlaceholder("")).toBe(true);
    expect(isPlaceholder("\n\n")).toBe(true);
    expect(isPlaceholder(PLACEHOLDER)).toBe(true);
  });
  test("a numbered list is set", () => {
    expect(isPlaceholder("\n1. Runs on Windows")).toBe(false);
  });
});

describe("appendEntry", () => {
  test("a placeholder is replaced by item 1", () => {
    expect(appendEntry(PLACEHOLDER, "Runs on Windows")).toBe("1. Runs on Windows");
  });
  test("numbering goes on after the items already there", () => {
    expect(appendEntry("\n1. Runs on Windows\n2. Costs under 20 EUR", "Never recommends option X")).toBe(
      "1. Runs on Windows\n2. Costs under 20 EUR\n3. Never recommends option X",
    );
  });
  test("prose before the list stays, and is not counted", () => {
    expect(appendEntry("Anything that fails one is out.\n\n1. A", "B")).toBe("Anything that fails one is out.\n\n1. A\n2. B");
  });
  test("later lines are indented under the first, so none is a heading", () => {
    const body = appendEntry("", "Never recommend X\n## not a heading\n\nreally");
    expect(body).toBe("1. Never recommend X\n   ## not a heading\n\n   really");
    expect(body.split("\n").some((l) => l.startsWith("## "))).toBe(false);
  });
  test("blank lines around the text are dropped", () => {
    expect(appendEntry("", "\n\n  only this  \n\n")).toBe("1. only this");
  });
});

describe("readAdded", () => {
  test("one JSON string per line; anything else is not an entry", () => {
    expect(
      readAdded(`${JSON.stringify("a")}\nnot json\n${JSON.stringify(3)}\n${JSON.stringify("b\nc")}\n${JSON.stringify(" ")}\n`),
    ).toEqual(["a", "b\nc"]);
  });
});

describe("expectedHard", () => {
  test("nothing added: the section as it was", () => {
    expect(expectedHard("\n1. A\n2. B", [])).toBe("1. A\n2. B");
  });
  test("entries added meanwhile are folded in, in order", () => {
    expect(expectedHard("\n1. A", ["B", "C"])).toBe("1. A\n2. B\n3. C");
  });
  test("an entry the section already holds is not added twice", () => {
    expect(expectedHard("\n1. A\n2. B", ["B", "C"])).toBe("1. A\n2. B\n3. C");
  });
  test("a placeholder with entries added meanwhile is those entries", () => {
    expect(expectedHard(PLACEHOLDER, ["A"])).toBe("1. A");
  });
  test("a multi-line entry is held as one", () => {
    const body = expectedHard("", ["A\nmore of A"]);
    expect(expectedHard(`\n${body}`, ["A\nmore of A"])).toBe(body);
  });
});

describe("sameHard", () => {
  test("whitespace does not count, words do", () => {
    expect(sameHard("\n1. A\n2. B\n", "1. A\n2.  B")).toBe(true);
    expect(sameHard("1. A\n2. B", "1. A\n2. B, unless it is close")).toBe(false);
  });
});
