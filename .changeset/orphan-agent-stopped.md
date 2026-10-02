---
"@vkuprin/ralph-harness": patch
---

A loop that is killed without the chance to stop its agent no longer leaves that agent running beside the next one. A `kill -9`, the OOM killer or bun crashing skips the loop's signal handler. The agent runs in a process group of its own, so it used to keep going in the loop's checkout after the loop was gone. `ralph status` called the loop stopped, `ralph stop` found nothing to stop, and the next `ralph start` ran a second agent in the same checkout. The loop now writes down the PID and start time of the command it is running, in `.child` in the loop directory. The next start stops that command and its group before anything else runs, and says so in `ralph.log`, but only when both the PID and the start time still match. Not on Windows yet.
