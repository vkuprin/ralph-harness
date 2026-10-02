---
"@vkuprin/ralph-harness": patch
---

`ralph start` now fails, with the loop's own reason, when the loop refuses to start. Before, it printed "started <name> as PID n" in green and exited 0 for every refusal there is: an unknown key or a wrong type in `config.json`, a config that does not parse, a missing `PROMPT.md`, a `REPO` that is not a git checkout, `PUSH: true` without `PUSH_CONFIRM`, a bad `ACTIVE_HOURS`, `PR_MERGE` without `PUSH: "pr"`. The loop had already stopped by then, and the reason was only in `ralph.log`. The loop now checks its settings before it takes its lock, so a loop holding the lock is one that runs.

Two `ralph start` at once used to both print "started". Sometimes `ralph.pid` then named the process the lock had turned away, so `ralph status` said stopped and `ralph stop` said "not running" while the loop ran on. Now one start reports the loop and the other fails with "already running", and `ralph status`, `stop` and `start` also find a running loop through the lock it holds.
