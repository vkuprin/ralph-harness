---
"@vkuprin/ralph-harness": patch
---

A loop whose `WORKTREE_DIR` points at a checkout that is not its own worktree now refuses to start. Belonging to the same repository used to be enough, so `WORKTREE_DIR` set to REPO itself, to a folder inside REPO, or to another loop's worktree all passed. After one iteration the uncommitted edits and untracked files there were gone, the checkout was left on `ralph/<name>`, and the agent's commit, never judged, stayed on the branch that had been checked out (`main`, or the other loop's branch, which that loop then pushed). The worktree must now be a worktree of its own, be neither REPO nor the repository's main checkout, and have `ralph/<name>` checked out or a detached HEAD.
