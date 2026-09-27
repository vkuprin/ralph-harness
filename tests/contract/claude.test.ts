import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "../../src/lib/config.ts";
import { claudeText } from "../../src/loop/cost.ts";
import { agentArgs, agentSettings, reviewerArgs } from "../../src/loop/loop.ts";

// The stub on the suite's PATH accepts any argv, so nothing else here checks
// that the real `claude` takes what the harness passes it, answers in the
// JSON the harness reads, or honours the steer hook's answer. This does, with
// the real CLI and a cheap model, and so it costs a few cents a run: it only
// runs when asked.
//
//   RALPH_REAL_CLAUDE=1 bun test tests/contract
const REAL = process.env.RALPH_REAL_CLAUDE === "1";
const it = test.if(REAL);
const MODEL = process.env.RALPH_CONTRACT_MODEL ?? "haiku";

const T = realpathSync(mkdtempSync(join(tmpdir(), "ralph-contract.")));
afterAll(() => rmSync(T, { recursive: true, force: true }));

function claude(args: string[], prompt: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["claude", ...args], {
    cwd: T,
    stdin: new TextEncoder().encode(prompt),
    env: { ...process.env, ...env },
    timeout: 240_000,
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("the real claude CLI takes what the harness passes it", () => {
  const c = { ...defaults(T), MODEL, REVIEW_MODEL: MODEL, LIVE_STEER: true, DENY: ["Bash(ssh *)"], ADD_DIRS: [T] };

  it("every flag the agent and the reviewer are given is one claude --help lists", () => {
    const help = Bun.spawnSync(["claude", "--help"]).stdout.toString();
    const flags = new Set([...agentArgs(c, T), ...reviewerArgs(c, T)].filter((a) => a.startsWith("--")));
    const missing = [...flags].filter((f) => !help.includes(f));
    expect(missing).toEqual([]);
  });

  it(
    "an agent run answers in the JSON the harness reads, and the steer hook reaches it",
    () => {
      writeFileSync(join(T, ".agent-settings.json"), JSON.stringify(agentSettings()));
      const steer = join(T, "STEER.md");
      writeFileSync(steer, "Stop and reply with the single word STEERED.\n");
      const r = claude(agentArgs(c, T), "Use the Bash tool to run `echo ping`. Then reply with one short line.", {
        RALPH_STEER_FILE: steer,
      });
      const run = claudeText(r.out);
      expect(r.code).toBe(0);
      expect(run.cost).toMatch(/^\d+\.\d{4}$/);
      expect(run.tokens).toMatch(/^\d+$/);
      // The hook ran on the tool call: it took the steer and kept it for the reviewer.
      expect(readFileSync(steer, { encoding: "utf8", flag: "a+" })).toBe("");
      expect(readFileSync(`${steer}.delivered`, "utf8")).toContain("STEERED");
    },
    300_000,
  );

  it(
    "a reviewer run ends with the VERDICT line the harness looks for",
    () => {
      const r = claude(reviewerArgs(c, T), "You are testing a harness. Reply with exactly this line and nothing else:\nVERDICT: ACCEPT\n");
      expect(r.code).toBe(0);
      const verdict = claudeText(r.out)
        .text.split("\n")
        .filter((l) => l.startsWith("VERDICT:"))
        .at(-1);
      expect(verdict).toBe("VERDICT: ACCEPT");
    },
    300_000,
  );
});
