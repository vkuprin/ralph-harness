---
"@vkuprin/ralph-harness": patch
---

On Windows, a loop that `NEXT_LOOP` starts no longer dies with the loop that started it. The harness's own job objects now let `ralph start` take the next loop out of them. `ralph status` now says `died` for a loop killed outright, one that left its `ralph.pid` behind and could send no `died` event, instead of `stopped`. `ralph stop` on such a loop clears it.
