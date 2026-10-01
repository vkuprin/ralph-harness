import { lstatSync, readlinkSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
