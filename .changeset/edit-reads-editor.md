---
"@vkuprin/ralph-harness": patch
---

`ralph edit` reads `EDITOR` the way git does, as a command: `EDITOR="code --wait"`, `subl -w` or `emacsclient -t` now open `PROMPT.md`. Before, the whole value was taken as the name of one program, so these, and an editor that is not installed, printed a stack trace and then held the terminal until it was killed. An editor that fails now makes `ralph edit` exit 1 and say so, and `ralph edit` on a loop that does not exist says so instead of opening an editor on a file nobody reads. An `EDITOR` that is the path of a program, and the default `vi` or `notepad`, run as before.
