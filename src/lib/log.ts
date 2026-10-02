import { appendFileSync, existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stamp } from "./clock.ts";

// ralph.log is where a human is sent: `ralph log`, `ralph tail` and `ralph
// status` read it, and it holds every agent's output and the harness's own
// errors both. A line is written to the file and to stdout, so a loop run by
// hand in a terminal still hears it; `ralph start` drops that stdout, and
// points only stderr at ralph.out, which nothing rotates.
//
// Nothing holds the file open between writes. Every child that writes here
// opens it when it starts, so a rotation between iterations cannot leave a
// descriptor filling ralph.log.1 for the rest of the run — the bug bash had to
// fix with `exec 2>>` after every rotation.
export class Log {
  constructor(readonly file: string) {}

  line(msg: string): void {
    const text = `[${stamp()}] ${msg}\n`;
    appendFileSync(this.file, text);
    try {
      writeSync(1, text);
    } catch {}
  }

  /** Text appended as it is: a command's output, copied in. */
  raw(text: string): void {
    if (text !== "") appendFileSync(this.file, text);
  }

  size(): number {
    try {
      return statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  /**
   * Rotate once past `maxBytes`: ralph.log.1 is the one before this, up to
   * `keep` of them. Everything numbered at or above `keep` goes, not only the
   * file at that number: a loop whose LOG_KEEP was lowered still carries the
   * files from the higher setting, and nothing else would remove them.
   */
  rotate(maxBytes: number, keep: number): void {
    if (!(maxBytes > 0)) return;
    const size = this.size();
    if (size < maxBytes) return;
    const dir = dirname(this.file);
    const base = basename(this.file);
    if (keep >= 1) {
      for (const f of readdirSync(dir)) {
        const m = f.startsWith(`${base}.`) ? /^\d+$/.exec(f.slice(base.length + 1)) : null;
        if (m && Number(m[0]) >= keep) rmSync(join(dir, f), { force: true });
      }
      for (let i = keep - 1; i >= 1; i--) {
        if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      }
      renameSync(this.file, `${this.file}.1`);
    } else {
      rmSync(this.file, { force: true });
    }
    writeFileSync(this.file, "");
    this.line(`log rotated at ${size} bytes; the ${keep} before this one are ${base}.1 and up`);
  }
}
