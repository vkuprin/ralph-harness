---
"@vkuprin/ralph-harness": patch
---

`ralph steer` with text of several lines writes one entry to PROMPT.md's Steering section, its later lines indented under the first. A line of the text that started with `## ` used to become a heading of PROMPT.md, and the reviewer, which reads the Steering section up to the next heading, was handed only the lines before it. A steer of only blank lines now prints the usage instead of writing an empty entry.
