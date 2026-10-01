---
"@vkuprin/ralph-harness": patch
---

Verdict reasons are plain text now. When a `VERIFY_CMD` printed in colour, as `bun test` does, the terminal escape codes ended up in `results.tsv`, `ralph results`, `RALPH_MESSAGE`, `ralph.log` and the next prompt, and `ralph results` printed its columns out of line. If the last line only reset the colour, the reason came out empty. The harness now removes escape codes and turns tabs into spaces when it builds a reason from a command's last line. That covers `VERIFY_CMD`, `HEALTH_CMD`, `gh`, a crashed agent and a limit message. The `VERIFY_CMD` and `HEALTH_CMD` output shown in the next prompt has its escape codes removed too.
