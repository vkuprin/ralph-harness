---
"@vkuprin/ralph-harness": patch
---

`ralph migrate` now refuses the lines that bash 3.2 and bash 5 read differently, instead of converting them the way one of them reads them. On a Mac, bash 3.2 is `/bin/bash`, and the old harness ran under whichever bash came first on `PATH`. A `~` after a bare `name=` inside a list (`FROZEN=(a=~/b)`, `(a=b:~/c)`) is expanded by bash 3.2 and kept by bash 5, and `ralph migrate` used to keep it. A backslash, or a line continuation, at the very end of `config.sh` is dropped by bash 3.2, kept by bash 5.3, and left the setting unset under the bash of a macOS CI runner.
