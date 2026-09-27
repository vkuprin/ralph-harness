// What GitHub says about a pull request's checks, read from
// `gh pr view --json url,state,headRefOid,statusCheckRollup`. Pure, so every
// state GitHub can report is pinned by a unit test rather than by a live CI.

export type Checks =
  | { verdict: "pass" }
  | { verdict: "none" }
  | { verdict: "pending"; names: string[] }
  | { verdict: "fail"; names: string[] }
  | { verdict: "stale"; seen: string }
  | { verdict: "merged" }
  | { verdict: "closed" }
  | { verdict: "unreadable" };

const PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
// STALE is GitHub giving up on a run that never finished: not a pass.
const FAIL = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE", "ERROR"]);

function field(o: object, key: string): string {
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

/**
 * One check: a CheckRun (GitHub Actions and apps) has a status and, once
 * completed, a conclusion; a StatusContext (the older commit-status API) has a
 * state. Anything not known to pass or fail is still running, so an unknown
 * value waits and the wait's bound decides, rather than counting as a pass.
 */
function one(item: unknown): { name: string; is: "pass" | "fail" | "pending" } {
  if (!item || typeof item !== "object") return { name: "(unreadable check)", is: "pending" };
  const name = field(item, "name") || field(item, "context") || "(unnamed check)";
  const typename = field(item, "__typename");
  const state = field(item, "state").toUpperCase();
  if (typename === "StatusContext" || (typename === "" && state && !field(item, "status"))) {
    if (state === "SUCCESS") return { name, is: "pass" };
    if (state === "FAILURE" || state === "ERROR") return { name, is: "fail" };
    return { name, is: "pending" };
  }
  const conclusion = field(item, "conclusion").toUpperCase();
  if (PASS.has(conclusion)) return { name, is: "pass" };
  if (FAIL.has(conclusion)) return { name, is: "fail" };
  return { name, is: "pending" };
}

/** The pull request's URL and what its checks say about `head`, the commit the harness pushed. */
export function readChecks(text: string, head: string): { url: string; checks: Checks } {
  // The harness keeps gh's stderr in the same file, so a notice gh prints
  // there (an update, a deprecation) can sit around the JSON.
  let view: unknown;
  try {
    view = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return { url: "", checks: { verdict: "unreadable" } };
  }
  if (!view || typeof view !== "object" || Array.isArray(view)) return { url: "", checks: { verdict: "unreadable" } };
  const url = field(view, "url");
  const state = field(view, "state").toUpperCase();
  if (state === "MERGED") return { url, checks: { verdict: "merged" } };
  if (state === "CLOSED") return { url, checks: { verdict: "closed" } };
  const seen = field(view, "headRefOid");
  // GitHub has not caught up with the push yet, or the checks are for another commit.
  if (seen !== head) return { url, checks: { verdict: "stale", seen } };
  const rollup = (view as Record<string, unknown>).statusCheckRollup;
  if (rollup !== undefined && rollup !== null && !Array.isArray(rollup)) return { url, checks: { verdict: "unreadable" } };
  const all = (rollup ?? []) as unknown[];
  if (!all.length) return { url, checks: { verdict: "none" } };
  const read = all.map(one);
  const failed = read.filter((c) => c.is === "fail").map((c) => c.name);
  if (failed.length) return { url, checks: { verdict: "fail", names: failed } };
  const pending = read.filter((c) => c.is === "pending").map((c) => c.name);
  if (pending.length) return { url, checks: { verdict: "pending", names: pending } };
  return { url, checks: { verdict: "pass" } };
}
