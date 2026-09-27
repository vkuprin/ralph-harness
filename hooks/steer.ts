#!/usr/bin/env bun
// Adapted from anthropics/cwc-long-running-agents
// (claude-code-config/.claude/hooks/steer.sh). Copyright 2026 Anthropic PBC.
// Modified for ralph: ported to TypeScript, the file comes from
// $RALPH_STEER_FILE, and the answer uses PreToolUse's hookSpecificOutput.
// SPDX-License-Identifier: Apache-2.0
//
// PreToolUse hook. When the loop's STEER.md has text, hand it to the agent once,
// by denying the tool call it was about to make — the reason of a deny is shown
// to the model — and empty the file. This is how `ralph steer` reaches the
// iteration already in flight.
//
// A convenience channel, not a trust boundary: the agent could write the file too.
import { appendFileSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";

const file = process.env.RALPH_STEER_FILE;
if (!file) process.exit(0);
try {
  if (statSync(file).size === 0) process.exit(0);
} catch {
  process.exit(0);
}

// Taken by rename, not read and then truncated: text a `ralph steer` appends
// between the read and the truncation would be lost. Appended after the rename,
// it lands in a new STEER.md and is delivered at the next tool call.
const taken = `${file}.taking.${process.pid}`;
try {
  renameSync(file, taken);
} catch {
  process.exit(0);
}
const text = readFileSync(taken, "utf8");
// Keep what was delivered, so the reviewer judges the commit against it too.
appendFileSync(`${file}.delivered`, text);
rmSync(taken, { force: true });
const steer = text.replace(/\n+$/, "");
if (steer === "") process.exit(0);

process.stdout.write(
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `OPERATOR STEERING (from ralph steer): ${steer}\n\nPause what you were about to do, fold this in, then continue.`,
    },
  })}\n`,
);
