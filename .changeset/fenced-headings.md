---
"@vkuprin/ralph-harness": patch
---

A `## ` or `### ` line inside a fenced code block in `PROGRESS.md` or `PROMPT.md` is no longer read as a heading. Before, an agent that quoted a script with a `## build` comment in a Log entry broke the Log there. When `PROGRESS_KEEP` reached that entry, half of it went to `PROGRESS-archive.md`, the comment was left in `PROGRESS.md` as a real heading, and every older entry stayed under it with nothing ever capping it again. The same fenced line in `PROMPT.md` cut the job the reviewer reads at the fence, so the reviewer never saw the rules written after it. And a question under "Needs a decision" that came after such a block sent no notification. A fence that never closes is not treated as one, so a stray ``` hides no heading after it.
