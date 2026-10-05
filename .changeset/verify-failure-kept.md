---
"@vkuprin/ralph-harness": minor
---

A failed `VERIFY_CMD` is easier to read after the fact. The reason in `results.tsv`, the log and the next prompt now leads with the first line of its output that reports a failure, followed by the summary line, instead of the summary alone. The whole output of every failed run is kept under `verify-failed/<epoch>-<iteration>.out` in the loop directory, bounded by `REF_KEEP`, and the next prompt names the file. `HEALTH_CMD`'s notification picks its line the same way.
