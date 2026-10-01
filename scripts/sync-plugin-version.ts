// The release job runs this after `changeset version`, so the plugin carries the
// version npm gets. Claude Code updates an installed plugin only when its version
// goes up, so a version that stayed behind would freeze the skill for everyone.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = join(root, "plugin", ".claude-plugin", "plugin.json");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const { name, ...rest } = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
delete rest.version;
writeFileSync(manifest, JSON.stringify({ name, version, ...rest }, null, 2) + "\n");
