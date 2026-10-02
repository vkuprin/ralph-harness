---
"@vkuprin/ralph-harness": patch
---

A `git fetch` the loop runs is now cut off after 300 seconds the machine was awake, as its `git push` already was. Before, a fetch with no time limit could hang the loop for good: a connection that stalls, or a credential helper waiting on a browser window nobody sees, never fails by itself. The loop then sat between two iterations with nothing in `ralph.log` past "shipped", while `ralph status` said running. This covers the fetch when the worktree is created, the fetch before every push (`PUSH: true` and `PUSH: "pr"`), and the fetch of `ralph/<name>` in pull-request mode. A fetch that times out now logs "git fetch … timed out after 300s". The kept commits stay local, and the next sync tries again.
