# Working on ralph-harness

Bash, git and nothing else. Read `ralph.sh` top to bottom before changing it; it is
short on purpose.

## Layout

- `ralph.sh`: the loop. One process per loop directory.
- `ralph`: the CLI (`new`, `start`, `stop`, `status`, `results`, `steer`, …).
- `hooks/steer.sh`: PreToolUse hook that delivers `ralph steer` mid-iteration.
- `template/`: what `ralph new` copies into a loop directory.
- `tests/run.sh`: end-to-end tests; `tests/stub/claude` stands in for the CLI.

## Before you commit

    shellcheck ralph ralph.sh hooks/steer.sh tests/run.sh tests/stub/claude
    tests/run.sh
    RALPH_BASH=/bin/bash tests/run.sh    # macOS: the loop must run on bash 3.2

No `wait -n`, `${x,,}`, `mapfile`, `declare -A` or other bash-4-only syntax.

Nor `${x//a/b}` with user text as the replacement: bash 5.2 reads an `&` there as
the matched text, the way `sed` does, and bash 3.2 reads it literally — so one
command writes two different files under the two bashes this supports. `fill` in
`ralph` shows the shape that is safe in both. `sed` has the same reading, and
`&`, `|` and `\` are all legal in a path.

Nor `awk -v var="$text"` with user text: awk processes escape sequences in a `-v`
value, so `\t` arrives as a tab and `\n` as a newline — a steer naming a Windows
path used to reach `PROMPT.md` in two pieces. Pass it in the environment and read
`ENVIRON["var"]`, which awk does not rescan; `cmd_steer` shows the shape. Shortening
it back to `-v` reads better and is the bug. A numeric `-v` (`PROGRESS_KEEP`,
`PROGRESS_MAX_BYTES`) is fine, because a number has no escapes to process.

## Invariants: do not change these

- Every iteration is a new `claude -p`. Nothing but files crosses iterations.
- The gate is outside the model: git and commands the harness runs decide what
  shipped, never text the model prints.
- An iteration that ships nothing makes the loop back off, not stop (unless the
  user set `QUIET_STOP`).
- `PROMPT.md` is re-read every iteration.
- The prompt is bounded by the harness, not by a shape the agent writes. A file
  the agent authors may be tidied by structure it wrote (`PROGRESS_KEEP`), but
  what goes into the prompt has a bound that holds whatever it writes
  (`PROGRESS_MAX_BYTES`). A loop that fills its context dies, so that bound
  belongs outside the model like every other gate.
- A wait that holds work no gate has judged is bounded; a wait with nothing
  pending need not be. The agent's limit is waited out for ever on purpose — it
  costs nothing. The reviewer's is not, so it has a ceiling
  (`REVIEW_LIMIT_TRIES`): while it waits, the commit is ungated, `MAX_ITER` does
  not advance, and a restart sets that commit aside. Do not unify the two.
- A timeout is a budget of seconds the machine was awake, not of wall clock.
  `run_bounded` sums the gaps between its polls, each capped at
  `POLL_GAP_MAX`, instead of comparing `now - start`. The two are the same
  arithmetic while the machine stays awake — consecutive readings telescope —
  and only the sum survives a suspend, which otherwise kills a healthy agent
  on the first poll after the wake. `POLL_GAP_MAX` is a tolerance and not an
  opt-out: unlike `REF_KEEP` or `PROGRESS_MAX_BYTES`, a `0` or unreadable
  value falls back to the default, because no cap is the defect itself.
- Loop state lives in `$RALPH_HOME/<name>/`, never in the target repository.
- Anything that can discard commits runs only in the harness-owned worktree
  (`WORKTREE=1`), never in the user's own checkout.
- A setting the harness could not read is not a default. `config.sh` is checked
  with `bash -n` and a file that does not parse refuses the start, because
  sourcing one runs the lines before the error and silently leaves the rest at
  their defaults — which is how a loop written for a gated worktree ends up
  committing into the user's own checkout. Do not soften this to a warning. Judge
  the parse and not what sourcing returns: `[ -d x ] && ADD_DIRS=(x)` exits
  non-zero and is a valid config.
- A scaffold the harness could not write is not a scaffold. `ralph new` judges
  the loop name before it writes anything and fails loudly rather than leaving
  a loop that only breaks later, somewhere else. Two rules, and the second is
  not covered by the first: `ralph/a/b` is a perfectly valid *branch*, so
  `git check-ref-format` alone lets a `/` through, and a `/` nests the loop
  directory one level down where `ralph status` never looks. `mkdir` is checked
  for the same reason — it used to fail and still print `created`.
- A command the harness prints is a command someone will paste. The name gate
  above stops only at what git stops at, and `&`, `;`, `|`, `$`, a backtick and
  both quotes are all legal in a branch name, so a hint that prints the name raw
  is one the shell splits: `3. ralph start a&b` runs `ralph start a` in the
  background and then `b`. Each of the six goes through `shq`, which is
  `printf %q`, so a name needing nothing still prints bare — that is why the
  quoting looks absent most of the time and is not. Hand-written quotes are not
  the same thing and are what a partial fix leaves behind: `git -C "$repo"
  merge ralph/$name` looks quoted, and splits on the name. The six are the
  `ralph new` hint, the three `ralph start` prints, the `ralph migrate` hint,
  the message sending an old-layout loop to `ralph migrate`, and both commands
  in `ralph review`'s footer — a seventh added later needs `shq` too.
- Defaults keep a loop written for an older version behaving the same.
