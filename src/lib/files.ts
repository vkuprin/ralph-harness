import { existsSync, lstatSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Replace the text of a file a human owns, all at once: a reader sees the old
 * text or the new, never half of it. The new text is renamed over the file the
 * path's links end at, with that file's mode, so a path that is a symlink stays
 * one. Renamed over the path itself, it put a copy where the link was: a
 * PROMPT.md kept in a repository of the user's own and linked into the loop
 * directory no longer heard the user's edits, the steer never reached the file
 * they edit, and a file kept at 0600 came back 0644.
 */
export function rewrite(file: string, text: string): void {
  const real = linkEnd(file);
  const tmp = `${real}.tmp.${process.pid}`;
  writeFileSync(tmp, text, { mode: statSync(real).mode & 0o7777 });
  renameSync(tmp, real);
}

/**
 * Where a chain of symlinks ends, followed by hand: bun's `realpathSync` (both
 * of them) cannot open a path that holds a backslash on macOS and Linux, and a
 * loop directory may.
 */
function linkEnd(file: string): string {
  let p = file;
  for (let hops = 0; lstatSync(p).isSymbolicLink(); hops++) {
    if (hops >= 40) throw new Error(`${file}: too many levels of symbolic links`);
    p = resolve(dirname(p), readlinkSync(p));
  }
  return p;
}

/**
 * Whether two paths name one existing directory. By physical path first, with
 * `.native`: on Windows the JS realpath leaves an 8.3 short name as it is, and
 * git names the same directory by its long name, so C:\Users\RUNNER~1 and
 * C:\Users\runneradmin read as two. Bun's realpath (every one of them) throws
 * ENOENT for a path holding a backslash on macOS and Linux, where a backslash
 * is a letter like any other; there the two are compared by device and inode,
 * which no spelling of a path changes. A path that names nothing matches
 * nothing.
 */
export function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    try {
      const x = statSync(a, { bigint: true });
      const y = statSync(b, { bigint: true });
      return x.ino !== 0n && x.dev === y.dev && x.ino === y.ino;
    } catch {
      return false;
    }
  }
}

/**
 * Whether `dir` is the top of a git checkout. `.git` is a directory only in a
 * plain clone; in a linked worktree, a submodule and a clone made with
 * --separate-git-dir it is a file naming the real one. `ralph new` once asked
 * for a directory while the loop asked for either, so a loop that ran on any
 * of those three could not be scaffolded. Both ask here.
 */
export function isCheckout(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}
