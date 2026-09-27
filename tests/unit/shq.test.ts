import { describe, expect, test } from "bun:test";
import { hint, shq } from "../../src/lib/shq.ts";

const back = (word: string) =>
  Bun.spawnSync(["bash", "-c", `printf '%s' ${shq(word)}`]).stdout.toString();

describe("shq: a word as a shell reads it back", () => {
  const corpus = ["plain", "a&b", "a'b", 'a"b', "a b", "$HOME", "`id`", "$(id)", "a;b", "a|b", "C:\\temp\\new", "~x", "*", "", "tab\there", "new\nline", "é—ü"];
  for (const w of corpus) {
    test(`round trip: ${JSON.stringify(w)}`, () => {
      expect(back(w)).toBe(w);
    });
  }
  test("a word needing nothing is bare", () => {
    expect(shq("plain-name.1")).toBe("plain-name.1");
    expect(shq("/a/b:c@d")).toBe("/a/b:c@d");
  });
  test("hint quotes every word", () => {
    expect(hint("ralph", "start", "a&b")).toBe("ralph start 'a&b'");
  });
});
