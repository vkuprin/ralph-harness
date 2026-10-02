---
"@vkuprin/ralph-harness": patch
---

Loops that share a repository no longer delete each other's thrown-away commits. A commit a gate reverted or dropped was saved as `refs/ralph/<kind>/<time>-<iteration>`, with no loop in the name, and refs belong to the whole repository. So one loop's `REF_KEEP` pruning deleted the other loops' saved commits, even a loop set to keep every one, and `ralph review` listed every loop's thrown-away commits as its own. They are now saved under `refs/ralph/<name>/reverted/` and `refs/ralph/<name>/dropped/`, and a loop prunes and lists only its own. Refs an older version saved are left alone, and `ralph review` lists them under a heading of their own.
