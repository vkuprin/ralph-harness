// shq: a word as a shell will read it back. Every hint the CLI prints is a
// command someone will paste, and a loop name is a directory and a branch, not
// a label: git takes & ; | ( ) $ ` and both quotes in a branch name, so a hint
// that printed the name raw was one the shell split — `ralph start a&b` runs
// `ralph start a` in the background, then `b`. Like `printf %q` it quotes only
// what needs it, so an ordinary name still prints bare. Unlike `printf %q` it
// quotes a word that starts with `=`: zsh, macOS's login shell, reads `=x` as
// the path of the command x, or stops at "x not found", and git takes
// `ralph/=x` as a branch.
const SAFE = /^[A-Za-z0-9_./:@%+,-][A-Za-z0-9_./:@%+=,-]*$/;

export function shq(word: string): string {
  if (SAFE.test(word)) return word;
  return `'${word.split("'").join(`'\\''`)}'`;
}

/** A command line to print for pasting: every word through shq. */
export function hint(...argv: string[]): string {
  return argv.map(shq).join(" ");
}
