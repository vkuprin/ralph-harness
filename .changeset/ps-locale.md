---
"@vkuprin/ralph-harness": patch
---

`ralph status` and `ralph stop` now find a running loop whose directory holds a letter outside ASCII (a loop named `ø`, or a home like `/Users/jørgen`) even when the CLI runs without a UTF-8 locale, as it does from cron, launchd or an ssh session that sent no `LANG`. ps escaped those letters there (macOS printed `ø` as `M-CM-8`), so the loop's own directory did not match its command line: status called the loop stopped, a second `ralph start` said it had started, and `ralph stop` said the loop was not running and left it and its agent alive. ps is now asked in `C.UTF-8`, where it prints the path as it is.
