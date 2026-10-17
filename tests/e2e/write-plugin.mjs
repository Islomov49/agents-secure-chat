// Writes the Claude Code plugin (marketplace layout) to a directory, launching lincor with the given command.
// Used by the e2e run to load the plugin for one session via --plugin-dir, without installing anything.
//   node tests/e2e/write-plugin.mjs <dir> "<command>"
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [dir, command] = process.argv.slice(2);
if (!dir || !command) throw new Error('usage: write-plugin.mjs <dir> "<command>"');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { claudePluginFiles, claudeMarketplace } = await import(join(repo, "packages/cli/dist/templates.js")).catch(async () => {
  // The CLI ships as one bundle; load the templates through tsx-free source compilation fallback.
  const { build } = await import("esbuild");
  const out = join(dir, ".templates.mjs");
  await build({ entryPoints: [join(repo, "packages/cli/src/templates.ts")], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  return import(out);
});
const [cmd, ...args] = command.split(" ");
const files = { ...Object.fromEntries(Object.entries(claudePluginFiles({ command: cmd, args })).map(([k, v]) => [`agents-secure-chat/${k}`, v])), ".claude-plugin/marketplace.json": claudeMarketplace() };
for (const [path, content] of Object.entries(files)) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
console.log(`plugin written to ${dir}`);
