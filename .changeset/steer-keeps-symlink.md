---
"@vkuprin/ralph-harness": patch
---

`ralph steer` and the `PROGRESS_KEEP` cap now rewrite the file a symlinked `PROMPT.md` or `PROGRESS.md` points at, and leave the link in place. Before, both put a plain copy where the link was. For a `PROMPT.md` kept in your own repository and linked into the loop directory, that meant the steer never reached the file you edit, and none of your later edits to it reached the loop. A `PROMPT.md` kept at mode 0600 also came back as 0644 after a steer. The mode is now kept too.
