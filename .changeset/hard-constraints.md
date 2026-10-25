---
"@vkuprin/ralph-harness": minor
---

Hard constraints are a section of their own. `PROMPT.md` gets `## Hard constraints`: numbered pass/fail tests that filter results, where Steering only ranks them. `ralph steer --hard <name> "..."` adds one. The reviewer is handed the list verbatim and told to reject a commit whose result recommends, ranks or lists anything that fails one, including near misses and fallbacks, and that "nothing passes" is a complete answer. Such a reject is recorded as `revert:constraint`. An iteration that edits the section gets it put back, and a `steer --hard` that lands mid-iteration is kept. `ralph setup` (the ralph-new skill) now asks for hard requirements, exclusions and preferences, reads them back before scaffolding, and drops backlog items that work on an excluded option.

`ralph steer` says what will actually hear the steer. A loop that is not running gets a message naming the next `ralph start`, and nothing in `STEER.md`. A loop that `DONE_CMD` stopped is also told that a start stops again at once unless the work changes. With `LIVE_STEER` off, it says the next iteration reads it.
