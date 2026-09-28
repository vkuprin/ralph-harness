# @vkuprin/ralph-harness

## 1.0.0

The first published release. Install with `brew install vkuprin/tap/ralph` or
`bun add -g @vkuprin/ralph-harness`.

- A Ralph loop for Claude Code that runs for days: every iteration is a fresh
  `claude -p` that reads `PROMPT.md` and `PROGRESS.md`, and nothing but files
  crosses iterations.
- Git, not the model, decides what shipped. Each new commit goes through the
  `FROZEN` check, `VERIFY_CMD` and an optional read-only reviewer. A commit
  that fails is reset, one that passes is pushed.
- `WORKTREE` gives each loop its own worktree and branch `ralph/<name>`, so the
  agent never touches your checkout. `PUSH: "pr"` keeps one pull request up to
  date, and `PR_MERGE` merges it when the loop ends by itself and every check
  passes.
- `PLAN_FIRST` starts each iteration in plan mode. The harness approves the
  plan itself, then the same run carries it out.
- `ralph setup` opens Claude Code with the `ralph-new` skill, which asks how the
  loop should run and scaffolds it with `ralph new --set`.
- Other commands: `ralph start`, `stop`, `status`, `review`, `results`, `log`,
  `tail`, `steer` (redirect a running loop mid-iteration), `edit`, `migrate`
  (from the old bash harness's `config.sh`) and `--version`.
- Usage limits are waited out, an iteration that ships nothing backs off
  rather than stopping, and timeouts count only the time the machine was
  awake.
