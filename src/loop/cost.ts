import { canonicalJson } from "../lib/text.ts";

// What a run costs comes back only as JSON (--output-format json): one result
// object, or in verbose mode an array of messages whose last "result" is the
// one. The text goes to the log as it always did; the cost and tokens go to
// results.tsv, each "-" when the run did not say.

export interface RunText {
  /** What to append to the log: the run's result, or its errors. */
  text: string;
  /** Dollars as the CLI reports them, to four places, or "-". */
  cost: string;
  /** Input plus output tokens (cache reads not counted), or "-". */
  tokens: string;
}

export function claudeText(raw: string): RunText {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    j = undefined;
  }
  if (Array.isArray(j)) {
    j = j.filter((m) => m && typeof m === "object" && (m as { type?: unknown }).type === "result").at(-1);
  }
  // Not JSON at all — a run killed before it answered — is kept as it is.
  if (!j || typeof j !== "object" || Array.isArray(j)) return { text: raw, cost: "-", tokens: "-" };
  const o = j as Record<string, unknown>;
  const usage = o.usage && typeof o.usage === "object" ? (o.usage as Record<string, unknown>) : {};
  const tin = usage.input_tokens;
  const tout = usage.output_tokens;
  const tokens =
    (tin !== undefined && tin !== null) || (tout !== undefined && tout !== null) ? String((Number(tin) || 0) + (Number(tout) || 0)) : "-";
  const cost = typeof o.total_cost_usd === "number" ? o.total_cost_usd.toFixed(4) : "-";
  // A result that is not a string is written as JSON, as errors are.
  const result = o.result === undefined || o.result === null ? "" : typeof o.result === "string" ? o.result : canonicalJson(o.result);
  let text: string;
  if (Array.isArray(o.errors) && o.errors.length && !result) {
    text = o.errors.map((e) => (typeof e === "string" ? e : canonicalJson(e))).join("\n");
  } else if ("result" in o) {
    text = result;
  } else {
    text = raw;
  }
  return { text: `${text}\n`, cost, tokens };
}

/** A sum in which "-" means nothing is known. */
export function addCost(a: string, b: string): string {
  if (a === "-" && b === "-") return "-";
  return ((a === "-" ? 0 : Number(a)) + (b === "-" ? 0 : Number(b))).toFixed(4);
}
export function addTokens(a: string, b: string): string {
  if (a === "-" && b === "-") return "-";
  return String(Math.trunc((a === "-" ? 0 : Number(a)) + (b === "-" ? 0 : Number(b))));
}
