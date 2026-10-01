---
"@vkuprin/ralph-harness": patch
---

The CLI ends quietly with exit status 0 when whatever reads its output stops early: `ralph status | head -1`, `ralph status | grep -q running`, `ralph review x | less` quit after the first page. Before, `status`, `results`, `review`, `log`, `help` and the others printed a Bun stack trace (`EPIPE: broken pipe, write`) and exited 1, often after they had done their work, so under `set -o pipefail` a check like `ralph status | grep -q running` said a running loop was not running. A command that fails still exits 1 with its message on stderr.
