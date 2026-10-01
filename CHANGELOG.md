# @vkuprin/ralph-harness

## 2.1.1

### Patch Changes

- 37005a2: The `ralph-new` setup skill can now be installed as a Claude Code plugin: `/plugin marketplace add vkuprin/ralph-harness`, then `/plugin install ralph-harness@ralph-harness`. In a Claude session it's `/ralph-harness:ralph-new`. Nothing changes for the CLI.

## 2.1.0

### Minor Changes

- 3432535: Windows support. ralph now runs natively on Windows 10 and 11 with bun, Git for Windows and Claude Code's native `claude.exe`, and CI runs the whole suite there.
  
  - `VERIFY_CMD`, `HEALTH_CMD`, `NOTIFY_CMD` and the other `*_CMD` settings run in Git for Windows' bash, found next to `git.exe` (`RALPH_BASH` or `CLAUDE_CODE_GIT_BASH_PATH` names another). The `bash` on a Windows PATH, usually WSL's, is not used.
  - `ralph stop` asks the loop to stop through a `ralph.stop` file, since Windows has no TERM; the loop then kills the agent's whole process tree, logs where it stopped and exits. Timeouts kill the command's tree the same way.
  - `ralph status` and the lock tell a loop from a stranger by its command line, read from CIM.
  - `ralph tail` follows the log without `tail`, and `ralph edit` falls back to `notepad`.
  - A loop refuses to start when the `claude` on PATH is npm's `claude.cmd`, which cannot be started without cmd.exe reading the agent's arguments.
  - The npm package can now be installed on Windows (`os` includes `win32`).
  
  Nothing changes on macOS or Linux.

## 2.0.1

### Patch Changes

- 6b7ac2d: Occasionally `ralph start` left a loop that never actually started. On Linux, bun sometimes never finishes loading the loop's code: the process is running but idle, it writes nothing to `ralph.log`, and `ralph status` shows it as running. `ralph start` now waits until the loop has actually started. If that hasn't happened within 30 seconds, it kills the process, notes this in `ralph.log`, and starts it again, up to three times.

## 2.0.0

### Major Changes

- efc7d14: `PUSH: true` now needs `"PUSH_CONFIRM": "<BRANCH>"`. With PUSH true every kept commit goes straight to `origin/BRANCH`, and whatever deploys that branch deploys the commit too. Restarting an old loop could push to production that way. A loop with `PUSH: true` and no matching `PUSH_CONFIRM` now refuses to start and tells you the line to add, and `ralph new` won't scaffold one. New loops from the template use `PUSH: "pr"`.
  
  Also new:
  
  - `PR_DRAFT` (on in the template): the loop's pull request stays a draft while the loop runs, and it's marked ready when the loop ends by itself. If you give each stage of a job its own loop, the pull request matches the stage, and GitHub won't let anyone merge it halfway.
  - `LAND_OK_CMD`: your own check that `BRANCH` can move now, for example "no ingest run is in progress". While it fails, a push with `PUSH: true` or a merge with `PR_MERGE` waits, and you get one `land-held` notification.
  - The reviewer now sees each commit's message, which it couldn't read from git inside a worktree. It's also told which checks already passed (`VERIFY_CMD` and its output, frozen files), so it no longer rejects a commit only because it couldn't run the tests itself.
  - The agent is told that the harness runs `VERIFY_CMD` after each iteration, so it doesn't run the full check a second time itself. When `VERIFY_CMD` fails, the next prompt includes the last lines of its output and the `git cherry-pick` range that restores the reset commits.

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
