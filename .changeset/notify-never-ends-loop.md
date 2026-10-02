---
"@vkuprin/ralph-harness": patch
---

A notification no longer ends the loop. `RALPH_MESSAGE` is cut to 4000 bytes and has any NUL byte replaced by a space, so a question the agent pasted binary output into, or a `VERIFY_CMD` whose last line is a long JSON report, reaches `NOTIFY_CMD`. Before, the system refused to start the notifier, the loop stopped with an internal error, and the "stopped" notice that followed was lost the same way. A command the system refuses to start now exits 127 with the reason in its output, like a command that is not there.
