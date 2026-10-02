---
"@vkuprin/ralph-harness": patch
---

With `PLAN_FIRST`, an agent that plans twice in one run gets both plans into `ralph.log`, each on its own lines with a rule between them. The second plan used to be glued to the end of the first, so its heading sat on the first plan's last line. And when the harness cannot write the plan file (`.plan.md`), the plan is still approved: the failed write used to stop the approval tool from answering at all, which left the agent waiting.
