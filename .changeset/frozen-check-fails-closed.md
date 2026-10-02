---
"@vkuprin/ralph-harness": patch
---

The frozen-file check no longer passes when git cannot run it. It read only what `git diff` printed and ignored the exit status, so any `FROZEN` entry git refused turned the check off for every entry, and the commit that edited the measurement was kept. That covers an empty entry, unknown pathspec magic such as `:(bogus)x`, `../x`, and an absolute path, which names your checkout and not the worktree the check runs in. Now `ralph start` refuses such a `FROZEN` and quotes git's error. If the check fails during a run, the commit is reset (`revert:frozen`, "could not check the frozen files") and the loop stops. The reviewer is likewise no longer asked to judge an empty diff when `git log` or `git diff` fails. That iteration takes the reviewer-unavailable path. An agent that set `diff.renames` to a word git does not know used to cause both failures at once.
