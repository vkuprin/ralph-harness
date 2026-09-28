---
"@vkuprin/ralph-harness": major
---

`PUSH: true` now needs `"PUSH_CONFIRM": "<BRANCH>"`. With PUSH true every kept commit goes straight to `origin/BRANCH`, and whatever deploys that branch deploys the commit too. Restarting an old loop could push to production that way. A loop with `PUSH: true` and no matching `PUSH_CONFIRM` now refuses to start and tells you the line to add, and `ralph new` won't scaffold one. New loops from the template use `PUSH: "pr"`.

Also new:

- `PR_DRAFT` (on in the template): the loop's pull request stays a draft while the loop runs, and it's marked ready when the loop ends by itself. If you give each stage of a job its own loop, the pull request matches the stage, and GitHub won't let anyone merge it halfway.
- `LAND_OK_CMD`: your own check that `BRANCH` can move now, for example "no ingest run is in progress". While it fails, a push with `PUSH: true` or a merge with `PR_MERGE` waits, and you get one `land-held` notification.
- The reviewer now sees each commit's message, which it couldn't read from git inside a worktree. It's also told which checks already passed (`VERIFY_CMD` and its output, frozen files), so it no longer rejects a commit only because it couldn't run the tests itself.
- The agent is told that the harness runs `VERIFY_CMD` after each iteration, so it doesn't run the full check a second time itself. When `VERIFY_CMD` fails, the next prompt includes the last lines of its output and the `git cherry-pick` range that restores the reset commits.
