---
"@vkuprin/ralph-harness": patch
---

An agent keeps the git settings your environment gives through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n` and `GIT_CONFIG_VALUE_n` when the harness pushes. The setting that stops the agent's own push was written at index 0 with a count of 1, so a `core.hooksPath`, `safe.directory` or `user.email` set that way was gone for the agent, and only with `PUSH: true` or `"pr"`. It is now added after yours.
