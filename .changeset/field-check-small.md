---
"@vkuprin/ralph-harness": patch
---

Smaller fixes from real runs:
- A steer sent mid-iteration reaches the reviewer once, not twice, and the log says it was delivered.
- `verify-failed/` files are plain text, without a login shell's escape sequences, and each is capped at its last 1 MB.
- A commit set aside at start names both possible causes (an iteration stopped mid-run, or a commit made in the worktree while the loop was down), and gives the exact ref it was saved under.
- A sync that rebases says so, with the old and new hash, before `VERIFY_CMD` runs again.
- The start line says `auth=api-key` when `ANTHROPIC_API_KEY` is set, which `claude -p` bills instead of a Claude login, or `auth=login` otherwise.
