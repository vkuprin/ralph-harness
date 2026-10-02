---
"@vkuprin/ralph-harness": patch
---

`ralph new` now scaffolds a loop on a linked worktree (`git worktree add`), a submodule, or a clone made with `--separate-git-dir`. In those three a checkout's `.git` is a file that names the real repository, not a directory, and `ralph new` refused them as "not a git checkout", although the loop itself has always run in them. A directory git does not know, or a directory inside a checkout, is still refused, as the loop refuses it at its start.
