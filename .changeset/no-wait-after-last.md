---
"@vkuprin/ralph-harness": patch
---

A loop ends as soon as its last iteration (`MAX_ITER`) is over. Before, it first slept the pause meant for the next iteration (`STEP_SLEEP`, `QUIET_SLEEP`, or the `ERROR_SLEEP` backoff, which doubles up to an hour after a revert or a failure) and only then noticed there was none. With `ACTIVE_HOURS`, a last iteration that ended after the window closed made the loop wait until the window opened again, up to about a day. All that time `ralph status` showed it as running, and `PR_DRAFT` and `PR_MERGE` waited behind it. A usage limit on the last iteration is still waited out, because that iteration runs again.
