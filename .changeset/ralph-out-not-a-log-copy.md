---
"@vkuprin/ralph-harness": patch
---

`ralph.out` no longer grows for as long as a loop runs. `ralph start` pointed the loop's stdout at it, and every line the loop logs goes to stdout as well, so `ralph.out` was a second `ralph.log` that `LOG_MAX_BYTES` and `LOG_KEEP` never touched: ten iterations whose `VERIFY_CMD` ended on a 200 KB line left 2 MB in it. It now holds only what bun prints when the loop crashes. Everything the loop says is still in `ralph.log`.
