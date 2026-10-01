import { describe, expect, test } from "bun:test";
import { lastNonBlank, plain, stripEscapes } from "../../src/lib/text.ts";

const ESC = "\x1b";

describe("stripEscapes: a command's output without its terminal codes", () => {
  test("colours, as bun test prints them", () => {
    expect(stripEscapes(`${ESC}[31m(fail)${ESC}[0m one ${ESC}[1;32mok${ESC}[39;22m`)).toBe("(fail) one ok");
  });
  test("a hyperlink and a title, ended by ST or by BEL", () => {
    expect(stripEscapes(`${ESC}]8;;https://x.invalid${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe("link");
    expect(stripEscapes(`${ESC}]0;title\x07rest`)).toBe("rest");
  });
  test("the short sequences: a character set, a saved cursor", () => {
    expect(stripEscapes(`${ESC}(Bplain${ESC}7`)).toBe("plain");
  });
  test("tabs and newlines are output, and stay", () => {
    expect(stripEscapes("a\tb\nc\n")).toBe("a\tb\nc\n");
  });
  test("a title never ended does not swallow the lines after it", () => {
    expect(stripEscapes(`${ESC}]0;oops\nnext line\n`)).toBe("\nnext line\n");
  });
});

describe("plain: one line, fit for a column or a notification", () => {
  test("escapes gone, a tab and a carriage return a space each", () => {
    expect(plain(`${ESC}[31m(fail) one\tthing\r${ESC}[0m`)).toBe("(fail) one thing ");
  });
  test("a lone ESC is a space, not a code that eats what follows", () => {
    expect(plain(`a${ESC}`)).toBe("a ");
  });
  test("letters outside ASCII are text, not control characters", () => {
    expect(plain("my app ø — ✓")).toBe("my app ø — ✓");
  });
});

describe("lastNonBlank", () => {
  test("the last line that says something, as plain text", () => {
    expect(lastNonBlank(["ok", `${ESC}[31m(fail) one\tthing${ESC}[0m`, "  "])).toBe("(fail) one thing");
  });
  test("a line that only resets the colour says nothing", () => {
    expect(lastNonBlank(["real failure here", `${ESC}[0m`, ""])).toBe("real failure here");
  });
  test("nothing at all", () => {
    expect(lastNonBlank([])).toBe("");
    expect(lastNonBlank([`${ESC}[0m`, "\t"])).toBe("");
  });
});
