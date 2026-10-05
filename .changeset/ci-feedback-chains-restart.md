---
"@vkuprin/ralph-harness": minor
---

CI on the loop's own pull request now feeds back into the loop, stages can chain, and a loop that was stopped mid-gate no longer throws away work it already paid for.

- `CI_FEEDBACK` (with `PUSH: "pr"`): before every iteration the harness reads the checks on the last commit it pushed. When one has failed, the next prompt starts with the failing check, its job and step, and the last lines of its GitHub Actions log. `DONE_CMD` is not asked while CI is red, and you hear about it once (`ci-failed`). Checks that are still running are not waited for. Off by default; the template turns it on.
- `PR_FIX_ITERS` (with `PR_MERGE`): when the checks fail after the loop has ended, the loop goes back to work for up to that many iterations in total, with the failure in the prompt, and merges once the checks pass. You get `merge-blocked` only after that budget is used up. With `PR_DRAFT`, the pull request becomes a draft again while the loop works on the fix. `0`, the default, blocks the merge at once, as before.
- `DONE_TIMEOUT`: how long `DONE_CMD` may run. The limit used to be a fixed 300 seconds.
- `NEXT_LOOP` (with `PR_MERGE`): a loop you have already made, started once this loop's pull request merges. The `## Carry forward` section of this loop's `PROGRESS.md` is copied into that loop's `PROGRESS.md` first. `ralph stop` never merges, so stopping a stage also ends the chain there. A `NEXT_LOOP` that names no usable loop refuses the start. New events: `next` and `next-failed`.
- A commit is now judged at restart instead of being set aside, when the loop was stopped after the agent had finished but before the gates gave their verdict (for example during a long `VERIFY_CMD`). It goes through the same gates, and its row reads `judged at restart`. A commit from an agent that was stopped mid-run is still set aside, as before.
- `died`: a new event for a loop that a signal ended without `ralph stop`, such as a reboot or a session that closed under it. On every platform, `ralph stop` now writes `ralph.stop` before it signals, so the loop can tell the two apart. The log line also names the cause: `ralph stopped by signal during iteration N (SIGTERM)`, or `(ralph stop)`.
- On Windows, `ralph start` takes the loop out of the job object of the shell that ran it. Before, a loop started from an agent's shell tool died together with that shell. If the job does not allow this, `ralph start` says so.
