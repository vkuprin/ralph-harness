# ralph

[![test](https://github.com/vkuprin/ralph-harness/actions/workflows/test.yml/badge.svg)](https://github.com/vkuprin/ralph-harness/actions/workflows/test.yml)

A Ralph loop for Claude Code that runs for days. Every iteration is a fresh
`claude -p`, and git, not the model, decides what shipped.

Needs `bun`, `git` and the `claude` CLI. macOS and Linux. No npm dependencies.

## Install

```bash
git clone https://github.com/vkuprin/ralph-harness && cd ralph-harness
ln -s "$PWD/bin/ralph" ~/.local/bin/ralph
ln -s "$PWD/skills/ralph-new" ~/.claude/skills/ralph-new   # optional: /ralph-new in any Claude session
```

## Quick start

```bash
cd ~/code/my-app
ralph setup                  # Claude asks how the loop should run, then creates it
```

Or by hand:

```bash
ralph new audit ~/code/my-app --set 'VERIFY_CMD=npm test'
ralph edit audit             # write the job into PROMPT.md
ralph start audit
ralph status
```

## Commands

| Command | What it does |
| --- | --- |
| `ralph` | short guide and your loops |
| `ralph setup` | open Claude Code here with the setup skill; it asks questions and scaffolds the loop |
| `ralph new` | same as `ralph setup` |
| `ralph new <name> <repo> [--set KEY=VALUE]...` | scaffold a loop, with settings written into its `config.json` |
| `ralph edit <name>` | open `PROMPT.md` in `$EDITOR` |
| `ralph start <name>` | run it in the background |
| `ralph stop <name>` | stop the loop and everything the agent started |
| `ralph status [name]` | running or not, iterations, verdicts, HEAD |
| `ralph review <name> [n]` | what it shipped, what it threw away, what waits to merge |
| `ralph results <name> [n]` | last n verdicts as a table |
| `ralph log <name> [n]` | last n log lines |
| `ralph tail <name>` | follow the log |
| `ralph steer <name> "text"` | redirect it, starting with the iteration in flight |
| `ralph migrate <name>` | convert an old bash-harness `config.sh` to `config.json` |

A loop lives in `~/.claude/ralph/<name>/` (`$RALPH_HOME`): `config.json`,
`PROMPT.md` (the job), `PROGRESS.md` (its memory), `ralph.log`, `results.tsv`.

## Options

Set them in the loop's `config.json` (JSON with comments), or when creating it with
`ralph new … --set KEY=VALUE`. Read once at start: restart to apply. An unknown key
or a wrong type refuses the start. The defaults below are what `ralph new` writes; a
key left out of the file entirely is off for `WORKTREE`, `PUSH`, `REVIEW`,
`LIMIT_RESET` and `CHURN_AT`.

**Loop**

| Setting | Default | What it does |
| --- | --- | --- |
| `REPO` | your repo | the checkout to work on, absolute path. Required |
| `MODEL` | `"opus"` | model for the agent and the reviewer |
| `PLAN_FIRST` | `false` | start each iteration in Claude's plan mode; the harness approves the plan and the same run carries it out |
| `MAX_ITER` | `500` | hard ceiling on iterations |
| `QUIET_STOP` | `0` | stop after this many iterations in a row ship nothing; `0` never |
| `QUIET_SLEEP` | `1200` | seconds to wait after an iteration that shipped nothing |
| `STEP_SLEEP` | `30` | seconds between iterations that shipped |
| `ITER_TIMEOUT` | `7200` | seconds one agent run may take |
| `DONE_CMD` | `""` | your "job is done" check, before every iteration; exit 0 stops the loop |
| `ACTIVE_HOURS` | `""` | local hours iterations may start in, like `"22-08"`; empty is any time |
| `ADD_DIRS` | `[]` | extra directories the agent may read |
| `DENY` | `[]` | tool patterns the agent may never use, like `"Bash(ssh *)"` |
| `LIVE_STEER` | `true` | let `ralph steer` reach the iteration in flight |
| `ESCALATE_AFTER` | `3` | failures in a row before the prompt says pivot |
| `CLOSING` | names `PROGRESS.md` | last line of every prompt |

**Gates**

| Setting | Default | What it does |
| --- | --- | --- |
| `WORKTREE` | `true` | work in a harness-owned worktree on `ralph/<name>`; every gate needs it |
| `WORKTREE_DIR` | next to the repo | where the worktree goes |
| `SETUP_CMD` | `""` | run once in a new worktree, like `npm ci` |
| `VERIFY_CMD` | `""` | your check after every commit; failing resets the commit |
| `VERIFY_TIMEOUT` | `1800` | seconds `VERIFY_CMD` may take |
| `FROZEN` | `[]` | paths a commit may not touch |
| `REVIEW` | `true` | a read-only Claude reviewer judges each commit |
| `REVIEW_MODEL` | `MODEL` | the reviewer's model |
| `REVIEW_LIMIT_TRIES` | `12` | times a rate-limited reviewer is retried; `0` forever |
| `HEALTH_CMD` | `""` | your check of the running system, before every iteration; while it fails, fixing it leads the prompt |
| `HEALTH_TIMEOUT` | `300` | seconds `HEALTH_CMD` may take |
| `CHURN_AT` | `4` | flag files changed by this many of the last `CHURN_WINDOW` kept iterations; `0` off |
| `CHURN_WINDOW` | `8` | kept iterations `CHURN_AT` counts over |
| `CHURN_IGNORE` | `[]` | paths left out of that count |

**Push and pull requests**

| Setting | Default | What it does |
| --- | --- | --- |
| `BRANCH` | `"main"` | the base branch |
| `PUSH` | `true` | `true` pushes kept commits to `BRANCH`; `"pr"` pushes `ralph/<name>` and keeps one pull request open; `false` stays local |
| `PR_MERGE` | `false` | with `"pr"`, merge the pull request when the loop ends by itself and every check passes |
| `PR_MERGE_METHOD` | `"merge"` | `"merge"`, `"squash"` or `"rebase"` |
| `PR_MERGE_WAIT` | `3600` | seconds to wait for checks still running |
| `PR_MERGE_POLL` | `30` | seconds between two looks at the checks |

**Limits and errors**

| Setting | Default | What it does |
| --- | --- | --- |
| `RATE_LIMIT_SLEEP` | `1800` | wait before retrying after a limit |
| `LIMIT_RESET` | `true` | wait until the reset time the limit message names instead |
| `RATE_LIMIT_EXTRA_RE` | | more text that counts as a limit (regex, case-insensitive) |
| `RATE_LIMIT_RE` | built in | replaces the built-in limit pattern entirely |
| `ERROR_SLEEP` | `300` | wait after a failure, doubling up to an hour |
| `ERROR_STOP` | `0` | stop after this many failures in a row; `0` never |
| `ACTIVE_POLL` | `300` | seconds between clock checks while waiting |
| `POLL_GAP_MAX` | `60` | a longer gap between polls is a suspend and doesn't count against a timeout |

**Notifications**

| Setting | Default | What it does |
| --- | --- | --- |
| `NOTIFY_CMD` | `""` | shell command run on an event; the event is in `RALPH_EVENT`, `RALPH_LOOP`, `RALPH_DIR`, `RALPH_ITER`, `RALPH_MESSAGE` |
| `NOTIFY_TIMEOUT` | `30` | seconds it may take; its exit status is ignored |

Events: `stopped`, `refused`, `stuck`, `limit`, `limit-clear`, `decision`, `health`,
`health-clear`, `churn`, `pr`, `pr-blocked`, `merged`, `merge-blocked`.
`template/config.json` has a macOS notification and a Telegram example.

**Memory and logs**

| Setting | Default | What it does |
| --- | --- | --- |
| `PROGRESS_KEEP` | `8` | Log entries kept in `PROGRESS.md`; older ones go to `PROGRESS-archive.md`; `0` keeps all |
| `PROGRESS_MAX_BYTES` | `120000` | most of `PROGRESS.md` put into one prompt; `0` all |
| `LOG_MAX_BYTES` | `10000000` | rotate `ralph.log` past this size; `0` never |
| `LOG_KEEP` | `3` | rotated logs kept |
| `REF_KEEP` | `20` | thrown-away commits kept under `refs/ralph/`; `0` keeps all |

## How it works

- Every iteration is a new `claude -p` reading `PROMPT.md` and `PROGRESS.md`. It
  commits and rewrites `PROGRESS.md`; nothing else carries over.
- The agent never pushes. The harness checks each new commit (`FROZEN`,
  `VERIFY_CMD`, reviewer), resets the ones that fail, and pushes the rest.
- An iteration that ships nothing makes the loop wait longer, not stop, unless
  `QUIET_STOP` says so.
- A usage limit is waited out and doesn't count toward `MAX_ITER`.
- `ralph stop` stops the loop right away, together with any tests or servers
  the agent started.

## Safety

- The agent runs with `--dangerously-skip-permissions`. Run it where it can't
  reach production credentials, or in a container or VM.
- With `WORKTREE` on it never touches your own checkout, and only the harness
  pushes. `DENY` prevents accidents; it won't stop an agent determined to get
  round it.
- Anything the agent reads (`HEALTH_CMD` output, web pages) can carry
  instructions. Say in `PROMPT.md` what it must never write to.

## Tests

```bash
bun run check                                  # typecheck, then every test
RALPH_REAL_CLAUDE=1 bun test tests/contract    # against the real claude CLI, a few cents
```

## Credits

[Geoffrey Huntley](https://ghuntley.com/ralph/) for the technique;
[karpathy/autoresearch](https://github.com/karpathy/autoresearch),
[Continuous Claude](https://github.com/AnandChowdhary/continuous-claude),
[ralph-tui](https://github.com/subsy/ralph-tui),
[tcc-autoresearch](https://github.com/the-cloud-clockwork/tcc-autoresearch) and
Anthropic's [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
for ideas; [anthropics/cwc-long-running-agents](https://github.com/anthropics/cwc-long-running-agents)
for the steering hook, which `hooks/steer.ts` is adapted from (Apache-2.0).

## License

MIT, except `hooks/steer.ts` (Apache-2.0). See [LICENSE](LICENSE).
