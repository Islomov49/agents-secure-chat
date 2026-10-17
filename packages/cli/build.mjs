// Bundles the CLI and MCP server into one dependency-free file for `npx -y agents-room`.
import { build } from "esbuild";
import { readFileSync, chmodSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/bin.ts"],
  outfile: "dist/agents-room.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  define: { __LINCOR_VERSION__: JSON.stringify(version) },
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __lincorCreateRequire } from 'node:module';\nconst require = __lincorCreateRequire(import.meta.url);" },
});
chmodSync("dist/agents-room.js", 0o755);
console.log(`built dist/agents-room.js (${version})`);
