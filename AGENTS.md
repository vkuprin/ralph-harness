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
- Loop state lives in `$RALPH_HOME/<name>/`, never in the target repository.
- Anything that can discard commits runs only in the harness-owned worktree
  (`WORKTREE=1`), never in the user's own checkout.
- Defaults keep a loop written for an older version behaving the same.
