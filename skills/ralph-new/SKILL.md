---
name: ralph-new
description: Set up a new ralph loop (ralph-harness) on a repository. Asks the user how it should run (where the work lands, auto-merge of its pull request, the verify gate, the reviewer, when it stops, model, plan mode, hours, notifications) with AskUserQuestion, then scaffolds it with `ralph new --set` and fills in PROMPT.md. Use when the user asks to create, set up, configure or start a ralph loop, to run ralph on a repo, or says /ralph-new.
---

# Set up a ralph loop

A ralph loop runs a fresh `claude -p` on a repository over and over, and the harness
(git and commands, not the model) decides which commits are kept. Setting one up is
a handful of choices that change how the loop behaves for days. Ask about them with
the **AskUserQuestion** tool instead of guessing or leaving the template's defaults
unexplained, then scaffold the loop with those answers.

AskUserQuestion takes 1 to 4 questions per call and 2 to 4 options per question. An
"Other" option with free text is always added for the user, so do not add one
yourself. Headers are at most 12 characters. Put the option you recommend first and
end its label with "(Recommended)". Base that recommendation on what you found in
the repository, not on the template.

## 1. Find the CLI

`ralph setup` starts this skill and names the CLI's path in its first message. Use
that path and skip the lookup below.

```bash
command -v ralph || readlink ~/.claude/skills/ralph-new
```

If `ralph` is not on PATH, the skill's symlink points into the ralph-harness checkout
(`<checkout>/skills/ralph-new`), and the CLI is `<checkout>/bin/ralph`. Use that path
for every `ralph` command below. If neither exists, tell the user to clone
ralph-harness and link the skill, and stop.

## 2. The repository and the loop's name

- The repository is the current directory if it is a git checkout (`git rev-parse
  --show-toplevel`). Otherwise ask for its path in plain text.
- The name defaults to the repository's directory name. It becomes a directory under
  `$RALPH_HOME` (default `~/.claude/ralph`) and the branch `ralph/<name>`. It cannot
  hold a `/`, and `$RALPH_HOME/<name>` must not exist already. If it does, propose
  `<name>-2` or ask.

## 3. Look before asking (read-only)

Collect what the questions need:

- `git remote get-url origin`: is there a remote to push to?
- `gh auth status`: can the harness open and merge pull requests?
- The default branch: `git symbolic-ref --short refs/remotes/origin/HEAD`, else `main`.
- `.github/workflows/`: does the repository run CI on pull requests?
- Candidate verify commands, from `package.json` scripts (test, typecheck, lint,
  build; use the lockfile's package manager), a `Makefile`, `pyproject.toml`,
  `Cargo.toml` or `go.mod`. Prefer one command that runs tests and the type check
  together, for example `bun run check` or `npm test && npm run typecheck`.
- `CLAUDE.md` and `AGENTS.md`: rules the loop's PROMPT.md should repeat.

## 4. First round of questions

Ask these four questions in one AskUserQuestion call:

1. **Where the kept work goes** (header `Lands in`):
   - "PR, merged when the loop ends": the harness pushes `ralph/<name>`, keeps one
     pull request open, and merges it when the loop ends if every check on it
     passes. Recommend this when there is an origin and gh is logged in.
   - "PR, I merge it": the same pull request, merged by a human.
   - "Push straight to <branch>": each kept commit goes to the base branch.
   - "Stay local": commits stay on `ralph/<name>` for the user to merge.
2. **The gate every commit must pass** (header `Verify`): up to three of the
   commands you found, the best one first. If you found fewer than two, add
   "None (reviewer only)".
3. **The reviewer** (header `Reviewer`): "On (Recommended)" runs a read-only Claude
   that judges each commit against the job. "Off" skips it.
4. **When the loop stops** (header `Stops when`):
   - "A done check passes" (DONE_CMD)
   - "N iterations in a row ship nothing" (QUIET_STOP)
   - "After N iterations" (MAX_ITER)
   - "Only when I stop it"

   Then ask in plain text for the command or the number.

Two combinations need a word before you go on:

- A pull request that is merged when the loop ends is merged only when the loop
  **ends by itself**. `ralph stop` never merges. With "Only when I stop it" the merge
  never happens, so suggest a MAX_ITER or QUIET_STOP.
- With no CI workflow and no verify command, nothing tests the pull request, and the
  harness refuses to merge it. Say so, and suggest a verify command.

## 5. Second round of questions

Ask only the questions that apply, at most four per AskUserQuestion call, in this
order. If more than four apply, ask Notifications in one more call.

- **How to merge** (header `Merge how`), only with "PR, merged when the loop ends":
  "Merge commit (Recommended)", "Squash", "Rebase".
- **Model** (header `Model`): "opus (Recommended)", "sonnet".
- **Plan first** (header `Plan first`): each iteration starts in Claude's plan mode,
  the harness approves the plan at once, and the same run carries it out.
  - "Off": runs straight from the prompt. Recommend it for audits and lists of
    small, separate fixes.
  - "On": recommend it when each iteration is a bigger change across several
    files: a feature, a refactor, a migration.
- **Hours** (header `Hours`): "Any time (Recommended)", "Nights only (22-08)". The
  user can type another window, such as `9-17`, through Other.
- **Notifications** (header `Notify`):
  - "macOS notification"
  - "Telegram": it reads `TG_TOKEN` and `TG_CHAT` from the environment the loop
    runs in. Tell the user to export them.
  - "None"

## 6. The job

If the user has not already said what the loop is for, ask in plain text:

- what outcome it is chasing;
- what would convince them the job is done: a check or an example, not an adjective;
- what it must never touch.

## 7. Scaffold

Map the answers to settings. `WORKTREE` stays `true`, the template's value: every
gate needs it.

| Answer | Settings |
|---|---|
| PR, merged when the loop ends | `PUSH=pr`, `PR_MERGE=true`, plus `PR_MERGE_METHOD=merge\|squash\|rebase` |
| PR, I merge it | `PUSH=pr` |
| Push straight to <branch> | `PUSH=true` |
| Stay local | `PUSH=false` |
| Base branch, when it is not `main` | `BRANCH=<branch>` |
| A verify command | `VERIFY_CMD=<command>` |
| Reviewer off | `REVIEW=false` |
| A done check | `DONE_CMD=<command>` |
| Nothing shipped N times | `QUIET_STOP=<N>` |
| After N iterations | `MAX_ITER=<N>` |
| Model | `MODEL=opus\|sonnet` |
| Plan first on | `PLAN_FIRST=true` |
| Nights only | `ACTIVE_HOURS=22-08` |
| macOS or Telegram | `NOTIFY_CMD=<the matching example from the template's config.json>` |

Then run one command:

```bash
ralph new <name> <repo> --set PUSH=pr --set PR_MERGE=true --set 'VERIFY_CMD=bun run check'
```

Rules for this command:

- **Never write these settings into `config.json` by hand.** `--set` checks each value
  the way the loop will read it, writes it through `JSON.stringify`, and refuses the
  whole scaffold on a bad value, leaving nothing behind. A hand edit can break the
  JSON, and the loop then refuses to start.
- Each `--set` is one shell word. Wrap it in single quotes when the value holds spaces
  or shell characters.
- When a value holds a single quote (the macOS `NOTIFY_CMD` does), pass it through a
  quoted heredoc so the shell leaves it alone:

  ```bash
  ralph new <name> <repo> --set "NOTIFY_CMD=$(cat <<'EOF'
  <the command, exactly>
  EOF
  )"
  ```
- VALUE is read as JSON when it is JSON and suits the setting (`true`, `40`, `["a","b"]`),
  and as a plain string otherwise. So `PUSH=pr`, `REVIEW=false` and `VERIFY_CMD=npm test`
  all mean what they say.
- If `ralph new` refuses, it names the setting and the reason. Fix that value and run
  it again. Nothing was created.

## 8. Write PROMPT.md

Open `$RALPH_HOME/<name>/PROMPT.md` and replace each `<...>` placeholder:

- **The job**: the outcome, in two or three sentences.
- **Done looks like**: the check or example the user gave. The reviewer holds every
  commit against it.
- **Direction**: what to look for, in which order, and what to leave alone.
- **The repository**: the test and build commands, with how long they take.
- **Rules**: the project rules from `CLAUDE.md` and `AGENTS.md`, and anything the user
  said must never be touched.

Keep every other section as it is. The harness and the agent both rely on them.

## 9. Confirm and start

Show a short summary:

- the loop directory;
- the branch;
- where the work lands, and whether and how it is merged;
- the gate, the reviewer and the stop condition;
- whether iterations plan first.

Then ask with AskUserQuestion (header `Start`):

- "Start now (Recommended)": run `ralph start <name>`, then `ralph status <name>`.
- "Not yet": tell the user `ralph start <name>` starts it, and that `ralph edit <name>`
  opens PROMPT.md.
