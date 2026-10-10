import { describe, expect, test } from "bun:test";
import { capProgress, decisionKey, decisions, injectProgress } from "../../src/loop/progress.ts";

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

  // An agent hard-wraps its bullets and rewrites the file whole: read line by
  // line, every iteration asked a "new" question.
  const asked =
    "## Needs a decision\n\nThings only the human can settle. The loop records them here and does not act.\n\n" +
    "- **Should the old API stay behind a flag?** Removing it breaks two\n  callers outside this repo. Options:\n" +
    "  (a) keep the flag; (b) remove it now.\n" +
    "- **The e2e suite is flaky on CI.** One run in five fails\n  on a timeout.\n\n## Log\n";
  const rewrapped =
    "## Needs a decision\n\nThings only the human can settle. The loop records them here and does not act.\n\n" +
    "- **Should the old API stay behind a flag?**\n  Removing it breaks two callers outside this repo.\n" +
    "  - checked again: both callers still use it\n  Options: (a) keep the flag; (b) remove it now.\n\n" +
    "- **The e2e suite is flaky on CI.** One run in five\n  fails on a timeout.\n\n## Log\n";
  test("an item is the bullet with every line that continues it", () => {
    expect(decisions(asked)).toEqual([
      "- **Should the old API stay behind a flag?** Removing it breaks two\n  callers outside this repo. Options:\n  (a) keep the flag; (b) remove it now.",
      "- **The e2e suite is flaky on CI.** One run in five fails\n  on a timeout.",
    ]);
  });
  test("re-wrapping a question or adding to it keeps its key", () => {
    expect(decisions(rewrapped).map(decisionKey)).toEqual(decisions(asked).map(decisionKey));
    expect(decisions(asked).map(decisionKey)).toEqual(["should the old api stay behind a flag?", "the e2e suite is flaky on ci."]);
  });
  test("a new question has a key of its own", () => {
    const more = asked.replace("\n## Log", "- **Is the staging key in the vault?**\n\n## Log");
    expect(decisions(more).map(decisionKey)).toContain("is the staging key in the vault?");
  });
  test("the template's sentence and a placeholder are not questions", () => {
    for (const none of ["- _(nothing yet)_", "(none open)", "- None.", "- nothing open", "_(nothing yet)_"]) {
      const t = `## Needs a decision\n\nThings only the human can settle. The loop records them here and does not act.\n\n${none}\n\n## Log\n`;
      expect([none, decisions(t)]).toEqual([none, []]);
    }
  });
  test("a question written as a paragraph or under a ### heading still counts", () => {
    const t =
      "## Needs a decision\n\nShould the loop stop on main?\nIt meets the targets.\n\n### Staging key\n\nIt is not in the vault.\n\n## Log\n";
    expect(decisions(t).map(decisionKey)).toEqual(["should the loop stop on main?", "staging key"]);
  });
  test("a question with no full stop keeps its key when a sub-bullet or a paragraph is added", () => {
    const one = "## Needs a decision\n\n- the staging key is not in the vault\n";
    const more = "## Needs a decision\n\n- the staging key is not in the vault\n  - (a) ask ops for it\n\n  checked again in iteration 4\n";
    expect(decisions(more).map(decisionKey)).toEqual(decisions(one).map(decisionKey));
  });
  test("a hard-wrapped line without indent continues its bullet", () => {
    expect(decisions("## Needs a decision\n\n- the key is not\nin the vault\n")).toEqual(["- the key is not\nin the vault"]);
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

describe("a heading that only starts with a section's name is another section", () => {
  // `## Login flow` read as `## Log`: its three `### step` notes were counted as
  // Log entries. Above the Log, eight entries under PROGRESS_KEEP 8 read as
  // eleven, and the three oldest real ones went to the archive. Below it, the
  // notes themselves went.
  const head = "# Progress\n\n## Needs a decision\n\n- _(nothing yet)_\n\n";
  const login = "## Login flow\n\n### step 1\n\nform\n\n### step 2\n\nsession\n\n### step 3\n\nlogout\n\n";
  const log = (n: number, heading = "## Log") => {
    let s = `${heading}\n\n`;
    for (let i = n; i >= 1; i--) s += `### entry ${i}\n\nbody ${i}\n\n`;
    return s;
  };
  test("one above the Log is not counted, and no entry moves", () => {
    expect(capProgress(head + login + log(8), 8)).toEqual({ entries: 8, kept: null, archived: "" });
  });
  test("one below the Log ends it, and its notes stay", () => {
    expect(capProgress(head + log(8) + login, 8)).toEqual({ entries: 8, kept: null, archived: "" });
  });
  test("with entries to move, only Log entries move", () => {
    const r = capProgress(head + login + log(10) + login, 8);
    expect(r.entries).toBe(10);
    expect([...r.archived.matchAll(/^### (.*)$/gm)].map((m) => m[1])).toEqual(["entry 1", "entry 2"]);
    expect(count(r.kept!, /^### step/gm)).toBe(6);
  });
  test("a file with only a longer heading has no Log, so the cap says it does nothing", () => {
    expect(capProgress(`${head}## Logging\n\n### what we log\n\n### where it goes\n\n`, 1).entries).toBe(0);
  });
  test("the Log heading may still say more after the name", () => {
    for (const h of ["## Log (newest first)", "## Log: newest first", "## Log\r"]) {
      expect([h, capProgress(head + log(10, h), 8).entries]).toEqual([h, 10]);
    }
  });
  test("Needs a decision is read by its name as well", () => {
    expect(decisions("## Needs a decision\n\n- one\n\n## Needs a decisions log\n\n- two\n")).toEqual(["- one"]);
  });
});

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
