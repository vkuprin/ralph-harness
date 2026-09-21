#!/usr/bin/env bash
# Adapted from anthropics/cwc-long-running-agents
# (claude-code-config/.claude/hooks/steer.sh). Copyright 2026 Anthropic PBC.
# Modified for ralph: the file comes from $RALPH_STEER_FILE, and jq or python3
# does the JSON escaping.
# SPDX-License-Identifier: Apache-2.0
#
# PreToolUse hook. When the loop's STEER.md has text, hand it to the agent once,
# by refusing the tool call it was about to make, then empty the file. This is
# how `ralph steer` reaches the iteration already in flight.
#
# A convenience channel, not a trust boundary: the agent could write the file too.

f="${RALPH_STEER_FILE:-}"
[ -n "$f" ] && [ -s "$f" ] || exit 0

note="OPERATOR STEERING (from ralph steer): $(cat "$f")

Pause what you were about to do, fold this in, then continue."

if command -v jq >/dev/null 2>&1; then
  reason="$(printf '%s' "$note" | jq -Rs .)" || exit 0
elif command -v python3 >/dev/null 2>&1; then
  reason="$(printf '%s' "$note" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" || exit 0
else
  exit 0
fi

# Keep what was delivered, so the reviewer judges the commit against it too.
cat "$f" >> "$f.delivered"
: > "$f"
printf '{"decision":"block","reason":%s}\n' "$reason"
