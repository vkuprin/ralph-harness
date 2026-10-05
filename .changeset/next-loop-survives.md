---
"@vkuprin/ralph-harness": patch
---

On Windows, a loop that `NEXT_LOOP` starts no longer dies with the loop that started it. `ralph start` runs for the next stage in a job object that lets it take the next loop out. `ralph status` now says `died`, not `stopped`, for a loop that was killed outright, one that left its `ralph.pid` behind and could send no `died` event. `ralph stop` on such a loop clears it.
