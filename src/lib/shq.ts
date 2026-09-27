// shq: a word as a shell will read it back. Every hint the CLI prints is a
// command someone will paste, and a loop name is a directory and a branch, not
// a label: git takes & ; | ( ) $ ` and both quotes in a branch name, so a hint
// that printed the name raw was one the shell split — `ralph start a&b` runs
// `ralph start a` in the background, then `b`. Like `printf %q` it quotes only
// what needs it, so an ordinary name still prints bare.
const SAFE = /^[A-Za-z0-9_./:@%+=,-]+$/;

export function shq(word: string): string {
  if (word !== "" && SAFE.test(word)) return word;
  return `'${word.split("'").join(`'\\''`)}'`;
}

/** A command line to print for pasting: every word through shq. */
export function hint(...argv: string[]): string {
  return argv.map(shq).join(" ");
}
