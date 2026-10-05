---
"@vkuprin/ralph-harness": minor
---

`NEXT_LOOP` can count: with `{n+1}` in it, the next loop's name is this loop's number plus one, so `polish-3` with `"NEXT_LOOP": "polish-{n+1}"` hands over to `polish-4`. A next loop that does not exist yet is made at hand-over from this loop's `config.json` and `PROMPT.md`, so an open-ended chain of rounds needs no loops made ahead of time. The new `NEXT_FROM` setting names a different loop to make it from. Both are checked when the loop starts, as an existing next loop is.
