---
"@vkuprin/ralph-harness": patch
---

`LOG_KEEP: 0` now throws away every older log when the log rotates, as the template says. It used to skip the pruning, so `ralph.log.1` and up, left by a higher setting, stayed for good: `ralph log` showed their lines and `ralph status` counted their iterations as this loop's, and every rotation logged "the 0 before this one are ralph.log.1 and up".
