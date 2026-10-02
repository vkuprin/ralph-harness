import { describe, expect, test } from "bun:test";
import { capProgress, decisions, injectProgress } from "../../src/loop/progress.ts";

const seeded = (n: number) => {
  let s = "# Progress\n\n## Needs a decision\n\n- _(nothing yet)_\n\n## Log\n\n";
  for (let i = n; i >= 1; i--) s += `### entry ${i}\n\nbody ${i}\n\n`;
  return s;
};

describe("capProgress keeps the newest entries and archives the rest oldest first", () => {
  test("twelve entries against eight", () => {
    const r = capProgress(seeded(12), 8);
    expect(r.entries).toBe(12);
    expect((r.kept!.match(/^### /gm) ?? []).length).toBe(8);
    expect(r.kept).toContain("### entry 12");
    expect(r.kept).toContain("## Needs a decision");
    expect([...r.archived.matchAll(/^### entry (\d+)/gm)].map((m) => m[1])).toEqual(["1", "2", "3", "4"]);
  });
  test("nothing moves under the cap", () => {
    expect(capProgress(seeded(3), 8)).toEqual({ entries: 3, kept: null, archived: "" });
  });
  test("no Log heading: nothing to count", () => {
    expect(capProgress("# Progress\n\nnotes\n### not under a log\n", 8).entries).toBe(0);
  });
  test("a section after the Log is kept", () => {
    const r = capProgress(`${seeded(10)}## Later\n\nkept\n`, 8);
    expect(r.kept).toContain("## Later\n\nkept\n");
  });
});

describe("injectProgress bounds the prompt by bytes, never the file", () => {
  test("under the bound: the file as it is", () => {
    expect(injectProgress("small\n", 100, "/p")).toEqual({ text: "small\n", cut: null });
  });
  test("0 injects everything", () => {
    expect(injectProgress("x".repeat(500), 0, "/p").cut).toBeNull();
  });
  test("over the bound: whole lines from the top, and where the rest is", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const r = injectProgress(text, 50, "/loops/x/PROGRESS.md");
    expect(r.cut).toBe(Buffer.byteLength(text));
    const kept = r.text.slice(0, r.text.indexOf("\n[Cut off"));
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(50);
    expect(kept.startsWith("line 0\n")).toBe(true);
    expect(r.text).toContain("The whole file is on disk at /loops/x/PROGRESS.md");
  });
  test("bytes, not characters: em dashes count three each", () => {
    const text = `${"—".repeat(20)}\n${"—".repeat(20)}\n`;
    const r = injectProgress(text, 70, "/p");
    expect(r.cut).toBe(122);
    expect(r.text.startsWith(`${"—".repeat(20)}\n\n[Cut off`)).toBe(true);
  });
});

describe("decisions", () => {
  test("the items under Needs a decision, not the placeholder and not blank lines", () => {
    const text = "## Needs a decision\n\n- _(nothing yet)_\n- the key is missing\n\n## Verify next\n\n- not this\n";
    expect(decisions(text)).toEqual(["- the key is missing"]);
  });
  test("no section, no questions", () => {
    expect(decisions("# Progress\n")).toEqual([]);
  });
});

describe("a heading in a fenced code block is quoted text, not a heading", () => {
  // Twelve entries against eight, and entry 4, the first to move, quotes a
  // script whose comment is a `## `. Read as a heading it ended the Log: the
  // cap moved half of entry 4 (log: "moved 1"), left `## build first` in
  // PROGRESS.md as a real heading over a stray fence, and entries 1 to 3 sat
  // under it for good, where no cap ever counted them again.
  const snippet = "The script I ran:\n\n```bash\n## build first\nbun run build\n### and then\nbun test\n```\n\nIt passed.\n";
  const text = (() => {
    let s = "# Progress\n\n## Needs a decision\n\n- _(nothing yet)_\n\n## Log\n\n";
    for (let i = 12; i >= 1; i--) s += `### entry ${i}\n\n${i === 4 ? snippet : `body ${i}\n`}\n`;
    return s;
  })();
  const r = capProgress(text, 8);
  test("every entry is counted, and only entries", () => {
    expect(r.entries).toBe(12);
  });
  test("the four oldest move, whole", () => {
    expect([...r.archived.matchAll(/^### entry (\d+)/gm)].map((m) => m[1])).toEqual(["1", "2", "3", "4"]);
    expect(r.archived).toContain(`### entry 4\n\n${snippet}`);
  });
  test("PROGRESS.md keeps the newest eight and nothing of the snippet", () => {
    expect([...r.kept!.matchAll(/^### entry (\d+)/gm)].map((m) => m[1])).toEqual(["12", "11", "10", "9", "8", "7", "6", "5"]);
    expect(r.kept).not.toContain("build first");
    expect(r.kept).not.toContain("```");
  });
  test("a fenced ## under Needs a decision does not hide the items after it", () => {
    const p =
      "## Needs a decision\n\n- run this and say if it is right:\n\n  ```\n## not a heading\n  ```\n\n- the key is missing\n\n## Log\n";
    expect(decisions(p)).toContain("- the key is missing");
  });
});
