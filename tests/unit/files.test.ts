import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameDir } from "../../src/lib/files.ts";

const IS_WIN = process.platform === "win32";
const T = mkdtempSync(join(tmpdir(), "ralph-unit-files."));

describe("sameDir: one directory, however it is spelled", () => {
  const plain = join(T, "plain");
  const other = join(T, "other");
  mkdirSync(plain);
  mkdirSync(other);

  test("a directory is itself, and not its neighbour", () => {
    expect(sameDir(plain, plain)).toBe(true);
    expect(sameDir(plain, other)).toBe(false);
  });
  test("a path that names nothing matches nothing, not even itself", () => {
    expect(sameDir(join(T, "gone"), join(T, "gone"))).toBe(false);
    expect(sameDir(join(T, "gone"), plain)).toBe(false);
  });

  // Bun's realpath throws ENOENT for these, so they are where "nothing matches
  // nothing" is decided: both sides unknown once read as one repository.
  describe.skipIf(IS_WIN)("with a backslash in the path", () => {
    const a = join(T, "a\\b");
    const c = join(T, "c\\d");
    const link = join(T, "to-a");
    mkdirSync(a);
    mkdirSync(c);
    symlinkSync(a, link);

    test("two directories are two", () => {
      expect(sameDir(a, c)).toBe(false);
    });
    test("a directory is itself, by its name or through a link", () => {
      expect(sameDir(a, a)).toBe(true);
      expect(sameDir(link, a)).toBe(true);
      expect(sameDir(join(link, "."), join(T, ".", "a\\b"))).toBe(true);
    });
    test("and one that is missing is no match for another that is", () => {
      expect(sameDir(join(T, "x\\y"), join(T, "x\\y"))).toBe(false);
      expect(sameDir(join(T, "x\\y"), a)).toBe(false);
    });
  });
});
