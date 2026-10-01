import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// The plugin is its own folder holding only what it loads: as the repository
// root it carried package.json and bun.lock, and Claude Code installs a plugin's
// lockfile when someone adds it. The directory loads no symlinks, so the skill
// in it is a copy, and these keep the copy and the folder honest.
describe("the Claude Code plugin", () => {
  test("its ralph-new skill is the harness's skill, byte for byte", () => {
    expect(read("plugin/skills/ralph-new/SKILL.md")).toBe(read("skills/ralph-new/SKILL.md"));
  });

  test("the marketplace lists one plugin, the plugin folder, by the plugin's own name", () => {
    const market = JSON.parse(read(".claude-plugin/marketplace.json")) as {
      plugins: { name: string; source: string }[];
    };
    const plugin = JSON.parse(read("plugin/.claude-plugin/plugin.json")) as { name: string };
    expect(market.plugins.map((p) => [p.name, p.source])).toEqual([[plugin.name, "./plugin"]]);
  });

  test("the plugin folder holds no package manifest, lockfile or package config", () => {
    for (const f of ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "bunfig.toml", ".npmrc"]) {
      expect(existsSync(join(ROOT, "plugin", f))).toBe(false);
    }
  });
});
