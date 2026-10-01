---
"@vkuprin/ralph-harness": patch
---

The commands ralph prints now paste into zsh for a loop whose name starts with `=`. zsh, the login shell on macOS, reads a word like `=x` as the path of the command `x`, so `ralph start =x` stopped with "x not found", and `=ls` would have become `/bin/ls`. git takes `ralph/=x` as a branch, so such a loop could be made. Every hint now quotes a word that starts with `=`, as in `ralph start '=x'`. Names that need no quoting still print bare.
