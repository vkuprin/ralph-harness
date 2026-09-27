import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { stamp } from "./clock.ts";
import { splitLines } from "./text.ts";

// results.tsv: one row per iteration, written by the harness. The cost columns
// come after reason, so every reader that counts columns from the left reads
// what it always read, and a file started by an older harness keeps its
// seven-column header and rows.
export const HEADER = "time\titer\tbefore\tafter\tstatus\tsecs\treason\tcost_usd\ttokens";

export interface Row {
  before: string;
  after: string;
  status: string;
  secs: number;
  reason: string;
  cost?: string;
  tokens?: string;
}

export function record(file: string, iter: number, r: Row): void {
  if (!existsSync(file)) writeFileSync(file, `${HEADER}\n`);
  const reason = [...r.reason.replace(/[\t\n\r]/g, " ")].slice(0, 300).join("");
  const cells = [
    stamp(),
    String(iter),
    r.before.slice(0, 12),
    r.after.slice(0, 12),
    r.status,
    String(r.secs),
    reason || "-",
    r.cost || "-",
    r.tokens || "-",
  ];
  appendFileSync(file, `${cells.join("\t")}\n`);
}

/** The header line and the data rows, each split into cells. */
export function readResults(file: string): { header: string; rows: string[][] } {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { header: "", rows: [] };
  }
  const lines = splitLines(text);
  return { header: lines[0] ?? "", rows: lines.slice(1).map((l) => l.split("\t")) };
}

/** Rows whose verdict kept the commits, oldest first: [before, after]. */
export function keepRows(rows: string[][]): [string, string][] {
  return rows.filter((r) => (r[4] ?? "").startsWith("keep")).map((r) => [r[2] ?? "", r[3] ?? ""]);
}
