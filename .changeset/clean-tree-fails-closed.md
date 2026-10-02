---
"@vkuprin/ralph-harness": patch
---

With `WORKTREE`, the harness throws away whatever the agent left uncommitted before the gates run, so an uncommitted edit cannot help a commit pass. It ignored whether that clean worked. An agent that edited `measure.sh` without committing it and then made the worktree read-only got a commit kept: `git reset --hard` exited 128 and `VERIFY_CMD` ran the edited file. An agent that configured an fsmonitor hook answering "nothing changed" got the same result with every git command exiting 0. Now the clean runs with fsmonitor off, and a failed reset or clean resets the commit (`revert:unclean`, quoting git). A worktree that cannot be cleaned before an iteration stops the loop before the agent starts. `git clean` also removes a repository the agent left inside the worktree (such as a clone it looked at), which used to survive and fail the next `VERIFY_CMD`.
