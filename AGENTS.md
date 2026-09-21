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
- Defaults keep a loop written for an older version behaving the same.
