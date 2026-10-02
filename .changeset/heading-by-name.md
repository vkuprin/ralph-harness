---
"@vkuprin/ralph-harness": patch
---

The harness finds a section of `PROGRESS.md` or `PROMPT.md` by its whole name, not by a prefix. A `## Login flow` section in `PROGRESS.md` was read as the `## Log`, so `PROGRESS_KEEP` counted its `### ` notes as entries: above the Log, real entries were moved to `PROGRESS-archive.md` early; below it, the notes themselves were. A `## Logging` section hid the warning that the cap had no Log to count. The reviewer, handed the `## The job` section, was also handed a `## The jobs table` that followed it. A heading may still say more after the name (`## Log (newest first)`). A `## Logs` heading is no longer the Log; the loop says so in `ralph.log`, and `PROGRESS_MAX_BYTES` still bounds the prompt.
