import { describe, expect, test } from "bun:test";
import { hint, shq } from "../../src/lib/shq.ts";

// bash, and zsh where it is installed: it is macOS's login shell, and it reads
// some words bash leaves alone.
const shells = ["bash", ...(Bun.which("zsh") ? ["zsh"] : [])];
const back = (shell: string, word: string) => Bun.spawnSync([shell, "-c", `printf '%s' ${shq(word)}`]).stdout.toString();

describe("shq: a word as a shell reads it back", () => {
  const corpus = [
    "plain",
    "a&b",
    "a'b",
    'a"b',
    "a b",
    "$HOME",
    "`id`",
    "$(id)",
    "a;b",
    "a|b",
    "C:\\temp\\new",
    "~x",
    "*",
    "",
    "tab\there",
    "new\nline",
    "é—ü",
    "=x",
    "=ls",
    "PUSH_CONFIRM=main",
  ];
  for (const shell of shells) {
    for (const w of corpus) {
      test(`round trip in ${shell}: ${JSON.stringify(w)}`, () => {
        expect(back(shell, w)).toBe(w);
      });
    }
    // Every word of up to three characters from the set shq leaves bare, read
    // back by printf: a shell that expands any of them changes the output, and
    // zsh stops at the first "not found". In batches, because on Windows one
    // command line of all 2954 words (12027 bytes) came back as its first 2084
    // words, cut where the line passes about 8 KB, and the rest was lost
    // without an error.
    test(`every short word shq leaves bare reads back the same in ${shell}`, () => {
      const chars = [..."aZ09_./:@%+=,-"];
      const words = [...chars];
      for (const a of chars) for (const b of chars) words.push(a + b, ...chars.map((c) => a + b + c));
      const read: string[] = [];
      for (let i = 0; i < words.length; i += 500) {
        const batch = words.slice(i, i + 500).map(shq);
        const r = Bun.spawnSync([shell, "-c", `printf '%s\\n' ${batch.join(" ")}`]);
        read.push(...r.stdout.toString().split("\n").slice(0, -1));
      }
      expect(read).toEqual(words);
    });
  }
  test("a word needing nothing is bare", () => {
    expect(shq("plain-name.1")).toBe("plain-name.1");
    expect(shq("/a/b:c@d")).toBe("/a/b:c@d");
    expect(shq("PUSH_CONFIRM=main")).toBe("PUSH_CONFIRM=main");
  });
  test("a word starting with = is quoted, which zsh would read as a command's path", () => {
    expect(shq("=x")).toBe("'=x'");
  });
  test("hint quotes every word", () => {
    expect(hint("ralph", "start", "a&b")).toBe("ralph start 'a&b'");
  });
});
