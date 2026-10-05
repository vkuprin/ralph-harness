---
"@vkuprin/ralph-harness": patch
---

The docs and the log now say what happens to what `NOTIFY_CMD` starts: at `NOTIFY_TIMEOUT` it is killed with the notifier, `nohup` and `&` included. A notifier that times out logs that, and points at `NEXT_LOOP` for starting a next stage.
