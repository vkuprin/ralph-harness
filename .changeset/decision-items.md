---
"@vkuprin/ralph-harness": patch
---

The `decision` notification fires once per new question, not after every iteration. The "Needs a decision" section is now read as items (a bullet with its wrapped lines and sub-bullets, a paragraph, or a `###` heading), each identified by the first sentence of its opening paragraph. An agent re-wrapping its bullets or adding detail under a question no longer reads as a new question, and the template's own sentence and placeholders such as "(none open)" are no longer questions at all.
