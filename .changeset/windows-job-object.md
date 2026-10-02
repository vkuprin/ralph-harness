---
"@vkuprin/ralph-harness": patch
---

On Windows, a command the loop cuts off or stops no longer leaves behind the processes Git Bash started under it. A timed-out `git fetch` left its ssh transport running, and a `SETUP_CMD` stopped mid-run left what it had put in the background, because `taskkill /T` follows parent PIDs and Git Bash's fork and exec leave a process whose parent is already gone. Each bounded command now runs in a Windows job object of its own, and the kill ends the job before the tree.
