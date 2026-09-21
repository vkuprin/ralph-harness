# ralph

Long-running agent loops. One loop is a `while` loop that starts a **new** `claude -p`
every iteration, over one git checkout, until it runs out of iterations or you stop it.

The idea is Geoffrey Huntley's — "Ralph is a Bash loop" — and it has many
implementations. This one exists for a specific shape of job; the section below says
plainly when to use something else instead.

## Use the official plugin instead, unless

Claude Code ships `ralph-loop` in the official marketplace. It loops **inside your
current session**: a `Stop` hook returns `{"decision": "block", "reason": <the same
prompt>}`, so the session refuses to end and re-reads the prompt. Nothing new is
spawned.

For a task with an end — "build this API, tests green, then stop" — that is the better
tool. It is one slash command, it needs no files on disk, and you watch it work.

|                    | official `ralph-loop`                | this                                  |
| ------------------ | ------------------------------------ | ------------------------------------- |
| iteration          | same session, `Stop` hook blocks exit | a new `claude -p` process             |
| context            | accumulates until it compacts         | empty every time; memory is a file    |
| "did it work?"     | the model prints a completion promise | `git rev-parse HEAD` moved            |
| finding nothing    | keeps going at full speed             | backs off, keeps verifying            |
| lives for          | a session                             | days                                  |

Two differences carry the weight:

**Fresh context per iteration.** A loop that keeps one context spends it. Measured on
the job this was written for: 11 iterations over 9 hours, each one parsing tens of
thousands of selectors across 31 pages and diffing the results. The session that merely
*watched* that loop compacted twice. A loop inside a session would have compacted far
sooner, and each compaction throws away the detail that the next measurement needs.

Here, iteration 40 starts as clean as iteration 1 and reads `PROGRESS.md` — notes a
predecessor wrote for a stranger — instead of dragging a transcript behind it. The cost
is real and worth naming: the agent knows only what the previous one bothered to write
down. `PROGRESS.md` discipline is the whole ballgame, which is why the template spends
most of its words on it.

**The gate is outside the model.** The official plugin ends when the model says
`<promise>COMPLETE</promise>`; its hook has to add "do not lie to exit". Here the loop
asks git whether HEAD moved. A model that decides it is finished cannot end the loop,
and a model that quietly does nothing is visible in the log within one iteration.

The rest — backing off instead of stopping when an iteration ships nothing, re-reading
the prompt file every iteration so a running loop can be redirected — follows from
those two.

## Use

Clone it and run `./ralph` from the checkout. It needs `bash`, `git`, and the `claude`
CLI on `PATH`; nothing gets installed anywhere.

```bash
./ralph new audit ~/code/my-app     # scaffold ~/.claude/ralph/audit
$EDITOR ~/.claude/ralph/audit/PROMPT.md
./ralph start audit
./ralph status                      # all loops: running, iterations, HEAD
./ralph tail audit
./ralph steer audit "drop the CSS work, the login flow is broken"
./ralph stop audit
```

Loops live in `$RALPH_HOME`, which defaults to `~/.claude/ralph`, so it does not matter
which directory you call it from.

`steer` writes into `PROMPT.md`, which is re-read at the top of every iteration, so it
redirects a loop that is already running. It lands on the next iteration, not the one
in flight.

## Layout

```
ralph.sh        the loop itself; takes a loop directory
ralph           the CLI; manages loop directories under $RALPH_HOME
template/       what `ralph new` copies
```

A loop directory holds `config.sh` (repo, model, ceilings, sleeps), `PROMPT.md` (the
job, re-read every iteration) and `PROGRESS.md` (memory between iterations), plus the
log and pid the harness writes.

## What stays out of this repo

Only the harness is versioned here, which is why it is its own repository rather than a
directory inside a dotfiles checkout. Loop directories live in `~/.claude/ralph/` and
are never committed: `PROMPT.md` carries production hosts and per-project rules, and
`PROGRESS.md` grows into hundreds of kilobytes of task state. Tools are shared, state
is not.

## Settings worth setting

- `QUIET_STOP=0` — never stop on silence. Right for an open-ended audit, where an hour
  that found nothing says nothing about the next hour. Set it to `3` for a finite task
  list, where three silent iterations really do mean the list is done.
- `MAX_ITER` — the ceiling that always applies. It is the one thing standing between a
  bug in your prompt and a loop that runs all week.
- `ADD_DIRS` — extra directories the agent may read, beyond the repo and its loop
  directory.
