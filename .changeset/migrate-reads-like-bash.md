---
"@vkuprin/ralph-harness": patch
---

`ralph migrate` no longer hangs, and no longer writes a setting the old `config.sh` did not hold. A `;` inside a list (`FROZEN=(a;b)`) made it run until memory ran out, about 8 GB in 8 seconds; it is now refused. Four kinds of line used to convert to something other than what bash held, and each is now refused or read as bash read it. A brace in a list (`FROZEN=(src/{eval,score}.ts)`) used to become one path that matches nothing, which switched the frozen-file check off for both files. A `~` after a `:` (`PATH=/opt/bin:~/bin`) or after a line continuation was kept as a literal `~`. A list continued with ` \` at the end of each line gained empty entries, so git refused the frozen-file check's pathspec. Text glued to a list's closing `)` (`FROZEN=(a)#b`) was dropped. A backslash at the very end of the file is now kept, as bash keeps it.
