---
"@vkuprin/ralph-harness": minor
---

Windows support. ralph now runs natively on Windows 10 and 11 with bun, Git for Windows and Claude Code's native `claude.exe`, and CI runs the whole suite there.

- `VERIFY_CMD`, `HEALTH_CMD`, `NOTIFY_CMD` and the other `*_CMD` settings run in Git for Windows' bash, found next to `git.exe` (`RALPH_BASH` or `CLAUDE_CODE_GIT_BASH_PATH` names another). The `bash` on a Windows PATH, usually WSL's, is not used.
- `ralph stop` asks the loop to stop through a `ralph.stop` file, since Windows has no TERM; the loop then kills the agent's whole process tree, logs where it stopped and exits. Timeouts kill the command's tree the same way.
- `ralph status` and the lock tell a loop from a stranger by its command line, read from CIM.
- `ralph tail` follows the log without `tail`, and `ralph edit` falls back to `notepad`.
- A loop refuses to start when the `claude` on PATH is npm's `claude.cmd`, which cannot be started without cmd.exe reading the agent's arguments.
- The npm package can now be installed on Windows (`os` includes `win32`).

Nothing changes on macOS or Linux.
