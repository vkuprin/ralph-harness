---
"@vkuprin/ralph-harness": patch
---

`ralph start` now fails, with the loop's own reason, when the loop gives up while setting up its worktree. It used to stop waiting once the loop took its lock, which happens before the worktree is made. So a `BRANCH` that does not exist, a `SETUP_CMD` that fails, or a `WORKTREE_DIR` that is another repository's checkout or a folder with files in it each printed "started <name> as PID n" in green and exited 0. The loop had stopped about 130ms later, and the reason was only in `ralph.log`. Now `ralph start` also waits for the worktree and `SETUP_CMD`, for up to 30 seconds after the lock. A `SETUP_CMD` that takes longer is not waited out: `ralph start` says the loop is still starting and can still fail, and points to `ralph tail`.
