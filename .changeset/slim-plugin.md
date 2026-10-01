---
"@vkuprin/ralph-harness": patch
---

The Claude Code plugin is now its own `plugin/` folder with only the `ralph-new` skill in it. Before, the plugin was the whole repository, and adding it could install the repository's development dependencies too. Install it the same way as before: `/plugin marketplace add vkuprin/ralph-harness`, then `/plugin install ralph-harness@ralph-harness`.
