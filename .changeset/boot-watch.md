---
"@vkuprin/ralph-harness": patch
---

Occasionally `ralph start` left a loop that never actually started. On Linux, bun sometimes never finishes loading the loop's code: the process is running but idle, it writes nothing to `ralph.log`, and `ralph status` shows it as running. `ralph start` now waits until the loop has actually started. If that hasn't happened within 30 seconds, it kills the process, notes this in `ralph.log`, and starts it again, up to three times.
