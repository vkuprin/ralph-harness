---
"@vkuprin/ralph-harness": patch
---

The start says when a gate you set will judge nothing. A `FROZEN` entry that matches no file in the worktree (`Measure.sh` for `measure.sh`, or a typo) only stops a commit that adds that file, so an edit of the file you meant shipped; the log now names the entry, and the file git has when only the case differs. With `WORKTREE: false`, `VERIFY_CMD`, `REVIEW` and `FROZEN` never run, which the log now says, and the agent is no longer told that a commit touching a frozen file is reset.
