---
"@vkuprin/ralph-harness": patch
---

`ralph stop` stops the agent that a loop killed outright left running. After a `kill -9`, the OOM killer or a bun crash, the agent kept running in its own process group, and nothing enforced `ITER_TIMEOUT` any more. `ralph stop` said "not running" and left it writing into the checkout until the next `ralph start`. Now it stops that agent and its group, and says so on screen and in `ralph.log`. It uses the same check as the next start: the PID and start time in `.child` must still match, and it leaves alone a command whose parent is a running loop. Not on Windows yet.
