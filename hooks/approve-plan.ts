#!/usr/bin/env bun
// MCP server the agent is given as --permission-prompt-tool when PLAN_FIRST is
// on. A `claude -p` run only offers ExitPlanMode when something can answer the
// approval prompt; this is that something. It approves the plan and switches
// the session to bypassPermissions, so the same session carries the plan out.
// Every other prompt is denied, as it is in a --dangerously-skip-permissions run.
//
// JSON-RPC over stdio, one message per line. Exits when stdin ends.
import { appendFileSync, statSync } from "node:fs";

const PLAN_FILE = process.env.RALPH_PLAN_FILE;

type Msg = { id?: number | string; method?: string; params?: Record<string, unknown> };

function reply(id: Msg["id"], result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

/**
 * Keep the plan for the loop's log. The loop empties the file before each run,
 * so text already there is an earlier plan of this run: a rule goes between
 * the two, and each ends with a newline. Appended as it came, a second plan's
 * heading was glued to the first plan's last line. The file is only a record,
 * so a write that fails costs the record and never the approval: a throw here
 * once meant no answer at all, and the agent waiting on one.
 */
function record(plan: string): void {
  if (!PLAN_FILE) return;
  try {
    let before = 0;
    try {
      before = statSync(PLAN_FILE).size;
    } catch {}
    appendFileSync(PLAN_FILE, `${before > 0 ? "\n---\n\n" : ""}${plan.endsWith("\n") ? plan : `${plan}\n`}`);
  } catch {}
}

function decide(tool: string, input: Record<string, unknown>): object {
  if (tool === "ExitPlanMode") {
    if (typeof input.plan === "string") record(input.plan);
    return {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }],
    };
  }
  return {
    behavior: "deny",
    message: "Nobody is here to approve this. While planning, only read; once your plan is approved the session runs without prompts.",
  };
}

function handle(m: Msg): void {
  if (m.id === undefined) return; // a notification
  switch (m.method) {
    case "initialize":
      reply(m.id, {
        protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ralph", version: "1" },
      });
      return;
    case "ping":
      reply(m.id, {});
      return;
    case "tools/list":
      reply(m.id, {
        tools: [
          {
            name: "approve",
            description: "Answers permission prompts for a ralph loop: approves the plan, denies the rest.",
            inputSchema: {
              type: "object",
              properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
              required: ["tool_name", "input"],
            },
          },
        ],
      });
      return;
    case "tools/call": {
      const args = (m.params?.arguments ?? {}) as { tool_name?: unknown; input?: unknown };
      const input = args.input && typeof args.input === "object" ? (args.input as Record<string, unknown>) : {};
      const text = JSON.stringify(decide(typeof args.tool_name === "string" ? args.tool_name : "", input));
      reply(m.id, { content: [{ type: "text", text }] });
      return;
    }
    default:
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } })}\n`,
      );
  }
}

let buf = "";
const dec = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let nl = buf.indexOf("\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      try {
        handle(JSON.parse(line) as Msg);
      } catch {}
    }
    nl = buf.indexOf("\n");
  }
}
