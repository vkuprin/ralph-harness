import { describe, expect, test } from "bun:test";
import { inFence, isHeading, lastNonBlank, plain, putSection, section, stripEscapes } from "../../src/lib/text.ts";

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

describe("inFence: a line in a fenced code block is never a heading", () => {
  const fenced = (text: string) => inFence(text.split("\n"));
  test("backticks and tildes, the fence lines included", () => {
    expect(fenced("a\n```bash\n## x\n```\nb")).toEqual([false, true, true, true, false]);
    expect(fenced("~~~\n## x\n~~~")).toEqual([true, true, true]);
  });
  test("a fence closes only on its own kind, at least as long, with nothing after it", () => {
    expect(fenced("````\n```\n## x\n````")).toEqual([true, true, true, true]);
    expect(fenced("```\n~~~\n## x\n```")).toEqual([true, true, true, true]);
    expect(fenced("```\n``` not a close\n```")).toEqual([true, true, true]);
  });
  test("up to three spaces before a fence, as in a list item", () => {
    expect(fenced("- item\n\n  ```\n  ## x\n  ```")).toEqual([false, false, true, true, true]);
    expect(fenced("    ```\n## x\n    ```")).toEqual([false, false, false]);
  });
  test("```x``` on one line is inline code, not a fence", () => {
    expect(fenced("```x```\n## x\n```")).toEqual([false, false, false]);
  });
  test("a fence that never closes is not one, so a stray ``` hides no heading", () => {
    expect(fenced("```\n## x\n### y")).toEqual([false, false, false]);
    expect(fenced("```\n## x\n~~~\n## y\n~~~")).toEqual([false, false, true, true, true]);
  });
  test("a file of fences that never close is read in one pass, not one per fence", () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `\`\`\`${i}`);
    const t = performance.now();
    expect(inFence(lines).some(Boolean)).toBe(false);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("section", () => {
  test("a ## in a fenced code block does not end the section", () => {
    const prompt = "## The job\n\nRun this:\n\n```bash\n## build first\nbun run build\n```\n\nThen ship it.\n\n## Rules\n\n- none\n";
    expect(section(prompt, "## The job")).toBe("\nRun this:\n\n```bash\n## build first\nbun run build\n```\n\nThen ship it.");
  });
  test("nor does one start a section", () => {
    expect(section("```\n## Steering\nquoted\n```\n", "## Steering")).toBe("");
  });
  test("a heading that only starts with the name is another section", () => {
    // The reviewer is handed `## The job` as the job. A PROMPT.md for a job
    // board has a `## The jobs table` too, and its notes were handed over as
    // part of the job.
    const prompt = "## The job\n\nFix the login.\n\n## The jobs table\n\nschema notes\n";
    expect(section(prompt, "## The job")).toBe("\nFix the login.");
  });
});

describe("isHeading: the name, and not a longer word that starts with it", () => {
  test("the name alone, or followed by what does not go on with the word", () => {
    for (const line of [
      "## Log",
      "## Log ",
      "## Log\r",
      "## Log (newest first)",
      "## Log: newest first",
      "## Log — newest first",
      "## Log ##",
    ]) {
      expect([line, isHeading(line, "## Log")]).toEqual([line, true]);
    }
  });
  test("a longer word is another heading", () => {
    for (const line of ["## Login flow", "## Logging", "## Logs I read", "## Log-in", "## Log_2", "## Log2", "## Logø"]) {
      expect([line, isHeading(line, "## Log")]).toEqual([line, false]);
    }
  });
  test("a line that does not start with the name is not it", () => {
    expect(isHeading("### Log", "## Log")).toBe(false);
    expect(isHeading(" ## Log", "## Log")).toBe(false);
    expect(isHeading("## Lo", "## Log")).toBe(false);
  });
});

describe("putSection: a section's body set, the rest of the file as it was", () => {
  const doc = "# Progress\n\nIntro.\n\n## Needs a decision\n\n- none\n\n## Log\n\n### one\n";
  test("a new section goes before the first ## heading", () => {
    expect(putSection(doc, "## From a", "- keep the cache")).toBe(
      "# Progress\n\nIntro.\n\n## From a\n\n- keep the cache\n\n## Needs a decision\n\n- none\n\n## Log\n\n### one\n",
    );
  });
  test("one already there has its body replaced, and only its body", () => {
    const once = putSection(doc, "## From a", "- old");
    expect(putSection(once, "## From a", "- new\n- more")).toBe(putSection(doc, "## From a", "- new\n- more"));
    expect(section(putSection(once, "## From a", "- new"), "## From a")).toBe("\n- new");
    expect(section(putSection(once, "## From a", "- new"), "## Log")).toBe("\n### one");
  });
  test("a heading quoted in a code block is not the section", () => {
    const fenced = "# P\n\n```\n## From a\nquoted\n```\n";
    const out = putSection(fenced, "## From a", "- real");
    expect(out).toContain("```\n## From a\nquoted\n```");
    expect(out.endsWith("## From a\n\n- real\n")).toBe(true);
  });
  test("a file with no ## heading gets it at the end", () => {
    expect(putSection("# P\n", "## From a", "x")).toBe("# P\n\n## From a\n\nx\n");
    expect(putSection("", "## From a", "x")).toBe("## From a\n\nx\n");
  });
});
