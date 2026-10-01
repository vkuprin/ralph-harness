---
"@vkuprin/ralph-harness": patch
---

An `ITER_TIMEOUT` or `VERIFY_TIMEOUT` of 0 or less now means the default (7200s and 1800s), not a timeout that has already run out. Elsewhere in `config.json` a 0 turns a setting off (`QUIET_STOP`, `ERROR_STOP`, `CHURN_AT`), so 0 here reads as "no limit". Instead, `ITER_TIMEOUT` 0 killed every agent before it ran, and the reviewer with it. `VERIFY_TIMEOUT` 0 reverted every commit the agent had been paid for, as "verify timed out after 0s", one iteration after another. The other timeouts already fell back to their defaults this way. The loop now says so in `ralph.log` when it starts, and the prompt gives the agent the timeout that really applies.
