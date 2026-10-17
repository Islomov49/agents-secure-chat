// Writes the distributable integration files under /integrations from the same templates `lincor install` uses.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeMarketplace, claudePluginFiles, codexHooks, codexMcpToml, skillMarkdown } from "../src/templates.js";
import { PACKAGE, VERSION } from "../src/version.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const launch = { command: "npx", args: ["-y", `${PACKAGE}@${VERSION}`] };

const write = (path: string, content: string) => {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content.endsWith("\n") ? content : content + "\n");
  console.log("wrote", path);
};

for (const [path, content] of Object.entries(claudePluginFiles(launch))) write(`integrations/claude-code/agents-room/${path}`, content);
write(
  ".claude-plugin/marketplace.json",
  claudeMarketplace().replace('"./agents-room"', '"./integrations/claude-code/agents-room"'),
);
write("integrations/codex/config.toml", codexMcpToml(launch));
write("integrations/codex/hooks.json", JSON.stringify({ hooks: codexHooks(launch) }, null, 2));
write("integrations/codex/skills/agents-room/SKILL.md", skillMarkdown());
