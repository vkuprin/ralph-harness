# ralph-harness plugin

This plugin adds one skill, `ralph-new`, for setting up a ralph loop: a Claude
Code loop that runs on a repository for days, where git and your own checks
decide which commits are kept. In a Claude session it is
`/ralph-harness:ralph-new`.

The skill looks at the repository to recommend settings (its git remote,
`gh auth status`, CI workflows, package scripts, CLAUDE.md, AGENTS.md and deploy
config), asks how the loop should run (where the work lands, the verify
command, the reviewer, when it stops, the model and the hours), and creates the
loop by running the `ralph` CLI, `ralph new <name> <repo> --set KEY=VALUE`. The
loop's files go in `~/.claude/ralph/<name>/`, and the skill writes the job into
its `PROMPT.md`. At the end it asks whether to start the loop now with
`ralph start`.

Apart from `gh auth status`, which asks GitHub whether you are logged in, the
skill itself sends nothing over the network. The loop it creates runs
`claude -p` in a git worktree, and with the default `PUSH: "pr"` it pushes the
branch `ralph/<name>` and keeps a pull request open with `gh`. A `NOTIFY_CMD`
runs only if you set one.

The plugin needs the `ralph` CLI on `PATH`, which the plugin does not install:

```bash
brew install vkuprin/tap/ralph        # or: bun add -g @vkuprin/ralph-harness
```

Source, documentation and the CLI: https://github.com/vkuprin/ralph-harness.
MIT licensed.
