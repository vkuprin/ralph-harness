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

    shellcheck ralph ralph.sh hooks/steer.sh tests/run.sh tests/stub/claude tests/stub/gh
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

**A path is user text too**, and that is the half a first reading of this rule
misses: `cap_progress` passed its overflow file as `-v over="$DIR/.progress-…"`
beside a numeric `-v keep=`, and a backslash anywhere in `$DIR` — from
`RALPH_HOME`, or from the argument to `ralph.sh <loop-dir>`, neither of which is
vetted — made awk open a different file. With nothing at the mangled path awk
dies, the `||` swallows it and the cap goes quiet for the rest of the run; with
something there (an unknown escape such as `\q` drops its backslash and maps one
real directory onto another) awk writes the overflow into a directory the loop
does not own, the shell archives the empty file it made itself, and `mv`
truncates `PROGRESS.md` anyway — the loop's memory destroyed and logged as
archived. So judge the **values** on an `awk -v` line and not the line: a
retiring note that says "these uses are numeric" has to name each one, because
this site sat inside such a note for four iterations.

Nor a value written into `config.sh` unquoted, because that file is *sourced* and
bash reads the value back as its own language: `REPO="__REPO__"` let a `$` in a
repo path expand, a backtick or `$(…)` **run**, and a `"` end the string and
swallow the settings after it. `fill` writes the code position from `__REPO_SH__`,
which goes through `shq`; `__REPO__` stays raw for the `SETUP_CMD` comment, which
is a line the reader pastes and where `shq`'s output would be wrong inside its
double quotes. Two placeholders for one value reads like duplication and is not —
and putting the quotes back (`REPO="__REPO_SH__"`) reads more natural and is the
bug. `__REPO_SH__` is substituted before `__REPO__` because the short name is a
prefix of the long one. There are **two** writers of `REPO` into `config.sh` and
both go through `shq`: `fill`, and the `printf` in `cmd_migrate`. Fixing one and
documenting both is the shape of a partial fix.

Nor a path interpolated into a `pgrep -f` pattern, which is a *regex*: a loop
directory holding a `.` matched a sibling's path, so `ralph status` reported
`my.app` as running with `myXapp`'s PID and `ralph migrate my.app` sent the
reader to `kill` that stranger — while `+ ? * [ ( ^ $ \` and a valid `{n}`
matched something no path holds, so a running loop read as *stopped* and
`ralph migrate` renamed its `ralph.sh` out from under the live process. Measured
over thirteen names. `old_pid` now greps a constant and matches the directory
with a **quoted** `case` pattern, `*"$dir"/ralph*.sh*`; the quotes are what make
it literal, in 3.2 and 5.x alike, and dropping them reads tidier and is the bug.
The other two command-line guards were already safe and are the shape to copy:
`pid_of` quotes its `" $dir"`, and `lock_held` in `ralph.sh` matches a constant.
Old-layout names are the ones that reach this, because `ralph new`'s gate never
saw them — but `$RALPH_HOME` is in the path too and nothing vets that, so a
pattern built from either is wrong.

Nor a check in `tests/run.sh` that asserts about the whole machine. Four did —
`! pgrep -f "sleep 99[9]"` three times and `! pgrep -f "home-soa[k]"` once — and
each is a *negative* assertion, so any process anywhere carrying that text turns
it red: a `sleep 999` a human typed, or a second copy of this suite. The suite is
what a loop on this repository gives `VERIFY_CMD`, so a check that goes red for a
reason outside the commit resets work that was fine; it did, once. The run now
starts two such processes of its own and keeps them alive throughout, so a check
that reaches past this run fails while it is being written rather than months
later on somebody's laptop. Use `no_proc` (a `ps` snapshot matched with `grep -F`,
taken *before* the match so the matching command cannot match itself),
`sleeper_gone` (the PID the stub recorded), or `wait_proc` (one PID, `grep -F`) —
and never a bare `pgrep -f`. The same claim one scope in: `make_loop` and
`make_repo` refuse a fixture name this run has already used, because two sections
sharing one has happened twice and each time the check that went red was hundreds
of lines from the edit that caused it.

Nor `cmd &` followed by a `kill` before that child has managed to exec. It is
still *this* shell until it execs, so it runs the `EXIT` trap and deletes `$T`
out from under a run that is still going — measured under 3.2.57 and 5.3.9 alike,
and `$$` cannot tell the two apart, so the trap cannot defend itself. Start the
process above the trap, as the two strangers are, or wait until `ps` can see it
(`wait_proc`) before killing it.

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
- A job the harness could not read is not a job. `PROMPT.md` and `PROGRESS.md`
  are checked by `have_files` before **every** iteration, not only at the start,
  and a loop missing one stops. They are the only two files re-read every
  iteration (`config.sh` is read once on purpose — a restart is how a setting
  changes), and the agent can write in the loop directory, because it is told to
  rewrite `PROGRESS.md` there. Without the check the harness carried on: with
  `PROMPT.md` gone the next agent got its own notes, the verdict table and "Run
  one iteration now" — no job, under `--dangerously-skip-permissions`; with
  `PROGRESS.md` gone the prompt told it its memory had been clipped at `""`
  bytes and to read the rest on disk, of a file that is not there. Three things
  read like redundancy and are not. The start still calls `have_files` too, and
  deleting either call leaves the other hole. `-f` **and** `-r`, because a
  directory is readable and cannot be `cat`'d. And `review()` calls it again for
  itself: a reviewer asked with an empty brief still answers, and its ACCEPT
  cannot mean "this is what the loop asked for", so that iteration takes the
  existing reviewer-unavailable path instead. The loop stops one iteration
  later, so dropping the `review()` call looks harmless and ships one commit
  nobody judged.
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
- A notifier is not a gate. `NOTIFY_CMD` is bounded by `NOTIFY_TIMEOUT`, its
  exit status is dropped, and `notify` puts `RC` and `TIMED_OUT` back before it
  returns — those two are how the gates read their own `run_bounded`, so a
  notification placed between a gate and its verdict must not be able to
  decide it. The event goes in the environment (`RALPH_EVENT`, `RALPH_MESSAGE`,
  …) and never into the command's text, for the reason the sed and awk rules
  above give. Every stop notifies from **one** place, after the loop, out of
  `stop_why`, and every refusal through `refuse`, so a reason the human is told
  and the reason in the log cannot drift apart and a stop added later is heard
  about without its author knowing any of this. The refusals above the
  `config.sh` source cannot notify at all: the setting is in the file they
  could not read.
- With `PUSH=pr`, sync never discards a kept commit. `sync_once` may drop one
  iteration's unpushed work on a conflict or a failed re-verify; `sync_pr` holds
  everything since the last merge, so it leaves the branch on its old base and
  tells the human (`pr-blocked`) instead. Its push is leased on the exact commit
  the harness last pushed, or on none, so a commit a human pushed to
  `ralph/<name>` is never overwritten. Reusing `sync_once`'s drop path here
  looks like less code and is the bug.
- A reset time read from a limit message never lengthens the reviewer's wait.
  With `LIMIT_RESET=1` the ceiling is `REVIEW_LIMIT_TRIES × RATE_LIMIT_SLEEP`
  seconds, the same bound the retries always added up to; a reset past it gives
  up at once. A reset time just gone by is a late reset and falls back to
  `RATE_LIMIT_SLEEP`; rolling it forward to tomorrow waits a day for a limit
  that lifts in minutes.
- Defaults keep a loop written for an older version behaving the same.
