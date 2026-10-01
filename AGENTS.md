# Working on ralph-harness

TypeScript on Bun, git, and nothing else at runtime: no npm dependencies, no perl,
awk, sed or jq. Read `src/loop/loop.ts` top to bottom before changing the loop; it
is one class on purpose, so an iteration reads in order.

## Layout

- `src/loop/main.ts`: the loop process, one per loop directory — the lock, the
  config, signals. `src/loop/loop.ts`: the iteration, the gates, sync.
- `src/loop/{cost,limits,progress,active-hours,merge}.ts`: pure pieces with unit tests.
- `src/lib/`: `proc` (bounded runs, process groups, the freeze on a signal),
  `clock` (the one test seam into time), `config`, `log`, `results`, `shq`, `text`.
- `src/cli/main.ts`: the CLI (`setup`, `new`, `start`, `stop`, `status`, `results`,
  `steer`, …). `ralph setup` (and bare `ralph new`) opens Claude Code with
  `skills/ralph-new/SKILL.md` from the harness as system prompt. `src/cli/migrate.ts`: `ralph migrate`, config.sh to config.json.
- `bin/ralph`: the CLI's entry point, the file npm, Homebrew or a symlink puts
  onto PATH.
- `hooks/steer.ts`: PreToolUse hook that delivers `ralph steer` mid-iteration.
- `hooks/approve-plan.ts`: the MCP server `PLAN_FIRST` passes as
  `--permission-prompt-tool`; it approves ExitPlanMode and denies the rest.
- `template/`: what `ralph new` copies into a loop directory.
- `skills/ralph-new/`: the Claude Code skill that asks how a loop should run
  (AskUserQuestion) and scaffolds it with `ralph new --set`. It calls the CLI, so
  a flag it uses changes with the CLI in the same commit.
- `plugin/`: the Claude Code plugin that `.claude-plugin/marketplace.json` lists.
  It holds only what it loads, because Claude Code installs a plugin folder's
  lockfile and the repository root has one. Its `skills/ralph-new/SKILL.md` is a
  copy of the one above, since a plugin loads no symlinks: change both in the
  same commit, and `tests/unit/plugin.test.ts` fails until they match.
  Its `version` is the package's: the release job's `version-script`
  (`bun run version-packages`) runs `scripts/sync-plugin-version.ts` after
  `changeset version`, because Claude Code updates an installed plugin only when
  its version goes up. `scripts/` is build tooling, not read at runtime, so it
  stays out of `files`.
- `tests/e2e/`: end-to-end tests that drive the loop and the CLI as processes;
  `tests/unit/`: the pure parts; `tests/contract/`: the real `claude` CLI, only
  with `RALPH_REAL_CLAUDE=1`; `tests/stub/{claude,gh}` stand in for the CLIs.
- `.changeset/`: pending release notes; `CHANGELOG.md` is what they become.

## Before you commit

    bun run format       # prettier --write
    bun run check        # tsc, eslint, prettier --check, then every test
    bunx changeset       # when a user would notice the change: patch, minor or major

CI runs the same on Linux, on Windows (in Git Bash), and on macOS once the
repository is public; lint and formatting only on Linux. Bun is pinned there
(`oven-sh/setup-bun`, `bun-version`); raise it deliberately.

Two TypeScripts are installed. `@typescript/native` is TypeScript 7 and is what
`bun run typecheck` runs. `typescript` is TypeScript 6 under the name tools
import, because typescript-eslint needs the compiler API that TypeScript 7.0
does not ship. Once typescript-eslint supports 7, make `typescript` 7 again and
drop the alias. The 6 is installed directly, not as `@typescript/typescript6`:
Bun resolves that wrapper's own `typescript@^6` back to the wrapper, and the
API comes out empty.

ESLint runs on Bun (`bun --bun eslint`), which reads `eslint.config.ts`
without a loader. Prettier skips `template/` and `skills/` (read at runtime,
byte for byte) and Markdown.

## Releasing

Releases come from the `release` job in `.github/workflows/test.yml`, which runs
only on a push to `main` that every other job passed. With changesets pending it
opens a "chore: release" PR that bumps `package.json` and writes `CHANGELOG.md`;
merging that PR publishes `@vkuprin/ralph-harness` to npm (trusted publishing,
no token), pushes the `vX.Y.Z` tag, writes the GitHub Release and bumps
`Formula/ralph.rb` in `vkuprin/homebrew-tap` (over SSH with the `HOMEBREW_TAP_DEPLOY_KEY` secret, a deploy key that can write to the tap and nothing else).

What ships is the source tree, run by bun: the loop is spawned as
`src/loop/main.ts` and the hooks run as files, so a compiled binary would break
`LOOP_MARK` and every hook path. `files` in `package.json` is the list, and the
formula's `libexec.install` repeats it. A new top-level directory the harness
reads at runtime goes into both, or it works from a checkout and nowhere else;
the `package` job installs the packed tarball to catch that. `@changesets/cli`
is a devDependency; the runtime still has none.

## Rules the code has learned

No `String.replace` or `replaceAll` with a **string** replacement where the
replacement is user text: JavaScript reads `$&`, `$1` and `$$` in it as syntax,
the way bash 5.2 reads `&` in `${x//a/b}` and sed reads `&` in `s///`, so a repo
path holding a `$&` would be written as something else. Cut and join —
`text.split(placeholder).join(value)` — or pass a function. `fill` in
`src/cli/main.ts` shows the shape, and the placeholder it cuts on for the repo
is `"__REPO_JSON__"` with its quotes, so the template itself parses.

User text reaches a child process only through its environment or its stdin,
never interpolated into a command line a shell will read. That covers the
agent's words in `NOTIFY_CMD`'s `RALPH_MESSAGE`, a limit message, a steer, and a
path. The `*_CMD` settings are the user's own shell text and run as `bash -c
<setting>` with everything else in the environment; the harness adds nothing to
that string. Spawn with an argv array, never `shell: true`.

A path is not a pattern. The CLI and the lock identify a loop's process by
matching its command line with `includes` and `endsWith` against the loop
directory — literally — and never with `new RegExp(path)`: a loop directory
holding a `.` once matched a sibling's path, and one holding `+ ? * [ ( ^ $ \`
matched nothing, so a running loop read as stopped. The one RegExp in the lock
check (`/ralph.*\.sh/`, for the bash harness this replaced) is a constant.

Config values are written only through `JSON.stringify`. The config was once
sourced bash, and a value written unquoted into it let a `$` expand, a backtick
run and a `"` swallow the settings after it. JSON has none of that, but only as
long as nothing builds a config by concatenating strings. `ralph new` (its
`--set` values included) and `ralph migrate` both go through `JSON.stringify`,
and `ralph new` reads the config it wrote back through `parseConfig` before it
creates the loop directory.

A printed command is a command someone will paste. Every hint the CLI prints —
`ralph start`, `status`, `tail`, `stop`, `migrate`, `results`, the `git merge`
and `git show` in `ralph review`, the loop's own "convert them" line — goes
through `hint()` in `src/lib/shq.ts`, which quotes each word only when it needs
it, so a plain name still prints bare. A loop name may hold `& ; | $ \`` and
quotes, because git allows them in a branch. Hand-written quotes around one word
are what a partial fix leaves behind: build the line with `hint()`.

Nor a check in `tests/` that asserts about the whole machine. A negative
assertion like "no `sleep 999` is running" goes red for any process anywhere
with that text on its command line — a sleep a human typed, or a second copy of
the suite — and this suite is what a loop on this repository runs as its
`VERIFY_CMD`, so a check that goes red for a reason outside the commit resets
work that was fine. It did, once. `tests/helpers/preload.ts` starts two such
processes and keeps them alive for the whole run, so a check that reaches past
the run fails while it is being written. Use `noProc` (a `ps` snapshot matched
literally, taken before the match so the matching command cannot match itself),
`sleeperGone` (the PID the stub recorded), or `waitProc` (one PID). The same
claim one scope in: `fx.makeLoop` and `fx.makeRepo` refuse a path that already
exists, because two tests sharing a fixture has happened twice, and each time
the check that went red was hundreds of lines from the edit that caused it.

A test that spawns a process and later asks whether it is gone must ask whether
it *exited* (`await proc.exited`), not whether its PID answers `kill -0`: a
child of the test process stays a zombie until the test reaps it, and a zombie
answers.

Windows is a platform, not a port kept on the side, and every difference lives
in `src/lib/proc.ts` behind `IS_WIN`, so the loop reads the same on all three.
What stands in for what:

- No process groups: `killGroup` and `killTree` kill the tree with
  `taskkill /T /F`. No TERM a program started without a console can catch:
  `ralph stop` writes `ralph.stop` into the loop directory, and `main.ts` answers
  it through the same `onSignal` as a signal, freeze first. A new way to stop a
  loop goes through that one handler on both.
- No `ps` that sees native processes (Git's is MSYS's own): a command line and a
  start time come from CIM (`commandLineSync`, `upTimeSync`), with the PID in the
  environment. Windows quotes an argument holding a space, so the identity
  checks are `markThen` and `endsWithArg` in `src/paths.ts`, still literal.
- `*_CMD` runs in Git for Windows' bash (`bash()`), never the `bash` on PATH,
  which is usually WSL's. The MSYS bash drops every write to a handle opened for
  appending, so on Windows output bound for a file is pumped through a pipe
  (`pumped`); pass the file, never a descriptor, and the pump is yours for free.
- The agent is `claude.exe`. An npm `claude.cmd` is refused at start
  (`claudeProblem`), because starting a batch file means cmd.exe reading the
  agent's arguments, which is the shell this file forbids.
- In the suite the stubs are compiled to `.exe` by the preload, and on Windows
  `Fx.env` takes every other directory holding a `claude` off PATH. The suite
  run unmodified on Windows once reached the real `claude.exe` and ran paid
  sessions in its fixtures; the stub has to be the only claude there is.
  A test that puts a path into a `*_CMD` quotes it with `sq`: bash reads the
  backslashes of a bare Windows path as escapes.

## Invariants: do not change these

- Every iteration is a new `claude -p`. Nothing but files crosses iterations.
  `agentArgs` builds the argv afresh; nothing resumes or continues a session.
- With `PLAN_FIRST` the plan is approved by the harness's own prompt tool
  (`hooks/approve-plan.ts`), never by text the model prints. `claude -p` offers
  ExitPlanMode only when a permission host exists, which is why the tool is
  there. It approves ExitPlanMode alone, switching the session to
  bypassPermissions, and denies every other prompt, as a
  `--dangerously-skip-permissions` run does. Off, the argv, prompt and log are
  exactly what they were.
- The gate is outside the model: git and commands the harness runs decide what
  shipped, never text the model prints. The agent's text is read only when HEAD
  did not move, to tell a limit from a crash.
- An iteration that ships nothing makes the loop back off, not stop (unless the
  user set `QUIET_STOP`).
- `PROMPT.md` is re-read every iteration.
- The prompt is bounded by the harness, not by a shape the agent writes. A file
  the agent authors may be tidied by structure it wrote (`PROGRESS_KEEP`), but
  what goes into the prompt has a bound that holds whatever it writes
  (`PROGRESS_MAX_BYTES`, counted in bytes by `injectProgress`). A loop that fills
  its context dies, so that bound belongs outside the model like every other gate.
- A wait that holds work no gate has judged is bounded; a wait with nothing
  pending need not be. The agent's limit is waited out for ever on purpose — it
  costs nothing. The reviewer's is not, so it has a ceiling
  (`REVIEW_LIMIT_TRIES`): while it waits, the commit is ungated, `MAX_ITER` does
  not advance, and a restart sets that commit aside. Do not unify the two.
- A timeout is a budget of seconds the machine was awake, not of wall clock.
  `runBounded` sums the gaps between its polls, each capped at `POLL_GAP_MAX`,
  instead of comparing `now - start`. The two are the same arithmetic while the
  machine stays awake — consecutive readings telescope — and only the sum
  survives a suspend, which otherwise kills a healthy agent on the first poll
  after the wake. `POLL_GAP_MAX` is a tolerance and not an opt-out: unlike
  `REF_KEEP` or `PROGRESS_MAX_BYTES`, a value of `0` or less falls back to the
  default, because no cap is the defect itself.
- `runBounded` returns `{rc, timedOut}` and sets nothing. A notifier between a
  gate's command and the gate's verdict therefore cannot change what the gate
  reads — the bug bash had to guard against by saving and restoring `RC`.
- A signal stops the loop where it stands. The handler kills the bounded child's
  whole process group, and `freeze()` makes every primitive in `src/lib/proc.ts`
  stop returning, so the iteration in flight cannot run on to its gates, record
  a verdict or push while the handler cleans up. A new way to wait or to start a
  process goes through `proc.ts`, or it is a hole in that.
- Loop state lives in `$RALPH_HOME/<name>/`, never in the target repository.
- Anything that can discard commits runs only in the harness-owned worktree
  (`WORKTREE`), never in the user's own checkout.
- A setting the harness could not read is not a default. A `config.json` that
  does not parse, holds a key the harness does not know, or holds a value of the
  wrong type refuses the start, because running on with only the settings it
  understood is how a loop written for a gated worktree ends up committing into
  the user's own checkout. Do not soften this to a warning, and do not add a
  key to `Config` without adding it to `KINDS` — the unit test that compares
  `{REPO}` alone with the defaults is how that is noticed. A key left out takes
  `defaults()`, which is the harness's default and not the template's: a loop
  that never set `WORKTREE` must not gain a worktree, a push and a reviewer.
- A job the harness could not read is not a job. `PROMPT.md` and `PROGRESS.md`
  are checked by `missingFile` before **every** iteration, not only at the start,
  and a loop missing one stops. They are the only two files re-read every
  iteration (`config.json` is read once on purpose — a restart is how a setting
  changes), and the agent can write in the loop directory, because it is told to
  rewrite `PROGRESS.md` there. Without the check the harness carried on: with
  `PROMPT.md` gone the next agent got its own notes, the verdict table and "Run
  one iteration now" — no job, under `--dangerously-skip-permissions`. Three
  things read like redundancy and are not. The start checks too, and deleting
  either check leaves the other hole. A regular file **and** readable, because a
  directory is readable and cannot be read as a file. And `review()` checks again
  for itself: a reviewer asked with an empty brief still answers, and its ACCEPT
  cannot mean "this is what the loop asked for", so that iteration takes the
  reviewer-unavailable path instead. The loop stops one iteration later, so
  dropping the `review()` check looks harmless and ships one commit nobody judged.
- A scaffold the harness could not write is not a scaffold. `ralph new` judges
  the loop name before it writes anything and fails loudly rather than leaving
  a loop that only breaks later, somewhere else. Two rules, and the second is
  not covered by the first: `ralph/a/b` is a perfectly valid *branch*, so
  `git check-ref-format` alone lets a `/` through, and a `/` nests the loop
  directory one level down where `ralph status` never looks. `mkdir` is checked
  for the same reason — it used to fail and still print `created`.
- A notifier is not a gate. `NOTIFY_CMD` is bounded by `NOTIFY_TIMEOUT`, its
  exit status is dropped, and the event goes in the environment (`RALPH_EVENT`,
  `RALPH_MESSAGE`, …), never into the command's text. Every stop notifies from
  **one** place, after the loop, out of `stopWhy` (set by `stop()`, which logs it
  in the same words), and every refusal through `refuse()`, so a reason the human
  is told and the reason in the log cannot drift apart and a stop added later is
  heard about without its author knowing any of this. The refusals before
  `config.json` is read cannot notify at all: the setting is in the file they
  could not read.
- With `PUSH: "pr"`, sync never discards a kept commit. `syncOnce` may drop one
  iteration's unpushed work on a conflict or a failed re-verify; `syncPr` holds
  everything since the last merge, so it leaves the branch on its old base and
  tells the human (`pr-blocked`) instead. Its push is leased on the exact commit
  the harness last pushed, or on none, so a commit a human pushed to
  `ralph/<name>` is never overwritten. Reusing `syncOnce`'s drop path here
  looks like less code and is the bug.
- `PR_MERGE` merges only when the loop ends by itself, and never after a signal:
  `ralph stop` is the human deciding, and the merge is theirs too. It merges only
  the head the harness pushed (`--match-head-commit`), only while that head sits
  on `origin/BRANCH` (a branch `syncPr` left on its old base was never checked on
  top of `BRANCH`), and only within `PR_MERGE_WAIT`, because the wait holds work
  whose last gate has not answered. "No checks" counts as passing only with a
  `VERIFY_CMD`, and only when two readings a poll apart say so: GitHub can take a
  moment to register the checks a push starts. A stop that means the loop's own
  state is broken (`stop(why, true)`) does not merge.
- A reset time read from a limit message never lengthens the reviewer's wait.
  With `LIMIT_RESET` the ceiling is `REVIEW_LIMIT_TRIES × RATE_LIMIT_SLEEP`
  seconds, the same bound the retries always added up to; a reset past it gives
  up at once. A reset time just gone by is a late reset and falls back to
  `RATE_LIMIT_SLEEP`; rolling it forward to tomorrow waits a day for a limit
  that lifts in minutes.
- The log line shapes are an interface. `ralph status` counts
  `^\[.*=== iteration` and `shipped [0-9a-f]{40}` across every rotated log, and
  logs written by the bash harness are read the same way, so change those two
  lines and the counts of every existing loop change with them. `results.tsv`
  keeps its column order, with the cost columns last, and readers accept the
  seven-column files older loops have.
- `PUSH: true` needs `PUSH_CONFIRM` naming `BRANCH`. Every kept commit then lands
  on `BRANCH` at once, and whatever deploys `BRANCH` deploys it; a restarted old
  loop once had a commit on its way to production that way. `pushProblem` in
  `src/lib/config.ts` is the one check, and both `Loop.start()` (a refusal) and
  `ralph new` (no scaffold) ask it. Naming the branch, not a bare `true`, means a
  later change of `BRANCH` is confirmed again. This is the one place a loop
  written for an older version is refused on purpose: do not soften it to a
  warning, and do not let `ralph migrate` fill it in.
- `LAND_OK_CMD` holds; it never drops and never gives up. It is asked right
  before the harness moves `BRANCH` (the push in `syncOnce`, the merge in
  `mergeAtEnd`), and while it fails the push or the merge waits, unbounded, with
  one `land-held` notification per wait. The work it holds has passed every
  gate, so the wait is the cheap kind. With `PUSH: true` the wait sits inside
  sync, so no iteration starts and unpushed work stays one iteration's, as
  `syncOnce`'s drop path assumes; after it, sync fetches, rebases and verifies
  again. In `mergeAtEnd` it does not count against `PR_MERGE_WAIT`, which bounds
  the checks alone.
- With `PR_DRAFT` the pull request is a draft while the loop runs, which GitHub
  will not merge, and `prReady` marks it ready only when the loop ends by itself,
  before `mergeAtEnd` waits for checks (some CI skips drafts). After a signal it
  stays a draft, as a signal never merges.
- A started loop is not believed until it has run its first lines. Bun on Linux
  now and then never finishes loading `src/loop/main.ts`: the process sits in
  epoll with no child and no line of its own, and `ralph status` calls it
  running. `ralph start` waits until the loop holds `ralph.lock` under its PID or
  has exited, kills one that has done neither within 30s and starts it again, up
  to three times, saying so in `ralph.log`; `fx.startLoop` does the same for the
  suite. It is not our wait on a child: rewriting `run()` on `Bun.spawn` and
  polling the child's status changed nothing, and the hung processes had not run
  a line. `RALPH_TEST_BOOT_HANG` and `RALPH_TEST_BOOT_WAIT` are the suite's seams
  into it, unset outside it like `RALPH_TEST_CLOCK`.
- Defaults keep a loop written for an older version behaving the same.
