---
"@vkuprin/ralph-harness": patch
---

A loop whose repository path holds a backslash no longer takes a checkout it does not own for its worktree. When `WORKTREE_DIR` pointed at another repository's checkout and both paths held a backslash, the ownership check passed, the agent ran there, and the harness reset and cleaned that checkout afterwards, deleting its uncommitted files. Such a start is now refused with "is not a worktree of", as it always was for ordinary paths. A repository whose path holds a backslash still runs in its own worktree.
