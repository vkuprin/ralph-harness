---
"@vkuprin/ralph-harness": minor
---

On Windows, `ralph start` run from a shell whose job object lets nothing leave it, such as an agent's shell tool, no longer leaves the loop to die with that shell. It starts itself again through WMI, outside every job of the shell and with no window, and the loop keeps running. `ralph start <name> --in-job` keeps the old behaviour, where the loop stays in the job and ends with it.
