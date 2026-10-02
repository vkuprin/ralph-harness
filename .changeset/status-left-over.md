---
"@vkuprin/ralph-harness": patch
---

`ralph status` no longer says a bare `stopped` over a loop whose agent is still running. A loop killed outright (`kill -9`, the OOM killer, bun crashing) leaves the command it was running, usually the agent, going on with nothing to bound it, and `ralph status` and `ralph`'s list of loops showed only `stopped`, which gave nobody a reason to run the `ralph stop` that ends it. Status now adds a `left over` line naming the PID and the `ralph stop` command, and the list says "stopped, but left a process running". Neither stops anything. macOS and Linux only, as `ralph stop`'s own handling of it is.
