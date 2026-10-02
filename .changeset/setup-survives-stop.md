---
"@vkuprin/ralph-harness": patch
---

A loop stopped while its `SETUP_CMD` runs now stops the setup with it, and runs the setup again at the next start. `ralph stop` used to end only the shell running `SETUP_CMD`, so what it had started (`npm ci` under `bash`, say) ran on in the worktree with no loop above it. And the next start found the new worktree and its branch in place and reused them without running `SETUP_CMD`, so the agent worked in a checkout whose setup had never finished. The same held for a loop killed outright during setup. Now `SETUP_CMD` runs in a process group of its own, as every other command the loop waits on does, and the loop keeps `.setup-pending` in its directory until the setup has passed.
