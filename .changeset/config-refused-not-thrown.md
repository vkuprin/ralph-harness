---
"@vkuprin/ralph-harness": patch
---

Two kinds of `config.json` crashed the loop before it wrote a line, and `ralph start` printed "started" and exited 0 with `ralph.log` empty: a key every JavaScript object has (`toString`, `constructor`, `__proto__`, …), and a `RATE_LIMIT_RE` and `RATE_LIMIT_EXTRA_RE` that each compile but not joined by `|` (a `\k<name>` in one naming a group only the other has). Both are now refused like any other setting the harness cannot read: `ralph start` says why and fails, and `ralph new --set` creates nothing.
