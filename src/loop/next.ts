// NEXT_LOOP's name for the next stage. A plain name is that loop. A name
// holding {n+1} counts: the loop "polish-3" with NEXT_LOOP "polish-{n+1}"
// hands over to "polish-4", which, made from the same config.json, hands over
// to "polish-5", so an open-ended chain needs no loops made ahead of it. The
// name is cut on the counter, never read as a pattern: a loop name may hold
// `. + ( [`, which git allows in a branch.

export const COUNTER = "{n+1}";

/** The next loop's name for loop `name`, or why NEXT_LOOP gives none. */
export function nextName(template: string, name: string): { name: string } | { problem: string } {
  const parts = template.split(COUNTER);
  if (parts.length === 1) return { name: template };
  if (parts.length > 2) return { problem: `${COUNTER} goes in it once` };
  const [pre, post] = parts as [string, string];
  const fits = name.length > pre.length + post.length && name.startsWith(pre) && name.endsWith(post);
  const n = fits ? name.slice(pre.length, name.length - post.length) : "";
  if (!/^[0-9]+$/.test(n)) {
    return { problem: `this loop's name, ${name}, is not ${pre}<number>${post}, so ${COUNTER} has no number to count from` };
  }
  // Leading zeros keep their width: polish-09 hands over to polish-10.
  return { name: `${pre}${(BigInt(n) + 1n).toString().padStart(n.length, "0")}${post}` };
}

/** NEXT_LOOP counts, so the next loop is made when it is due. */
export const counts = (template: string) => template.includes(COUNTER);
