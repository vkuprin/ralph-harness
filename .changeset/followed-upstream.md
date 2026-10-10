---
"@vkuprin/ralph-harness": patch
---

A merge the agent pulls in from `BRANCH` is no longer recorded as the loop's commit. When an iteration's new HEAD is already on `origin/BRANCH` or `BRANCH` (a pull request merged mid-iteration, and the agent fast-forwarded to it), the iteration is quiet: no gate runs on the human's commits, no `shipped` line is written, and they stay out of "What this loop shipped recently" and the churn counts.
