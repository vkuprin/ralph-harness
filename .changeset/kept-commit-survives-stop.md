---
"@vkuprin/ralph-harness": patch
---

A commit the gates kept stays kept when the loop is stopped right after the verdict. After the keep row the loop runs its notifier (a `limit-clear` or a `decision` event), which can take up to `NOTIFY_TIMEOUT`. A `ralph stop`, a reboot or a crash during that run used to make the next start reset `ralph/<name>` and set the commit aside under `refs/ralph/dropped/` as "never judged", even though `results.tsv` called it `keep`. The log never said `shipped`, so `ralph status` did not count it, and with `PUSH` on it never reached origin. The harness now records the commit as judged, and logs it as shipped, at the moment it writes the keep row. The restart pushes the commit as it would any kept one.
