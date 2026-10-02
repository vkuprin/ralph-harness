---
"@vkuprin/ralph-harness": patch
---

`ralph log`, `ralph results` and `ralph review` refuse an `n` that is not a whole number of 1 or more, and print their usage. Before, `ralph review <name> -5` (the `tail -5` habit) said "nothing yet" over a loop's shipped commits, `ralph log` and `ralph results` printed nothing, `1e3` was read as 1, and `0` or a word as the default, every one of them with exit 0.
