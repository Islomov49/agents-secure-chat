// Builds the web app into web/dist:
//   src/main.ts → dist/app.js (esbuild, minified, browser, ES2022)
//   index.html, styles.css, favicon.svg → dist/ with content-hash query strings and SRI integrity attributes
//   dist/manifest.json: file hashes plus the CSP hash of the one inline script (for the server's headers)
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");

const digest = (algo, data, enc = "hex") => createHash(algo).update(data).digest(enc);
const short = (data) => digest("sha256", data).slice(0, 12);
const sri = (data) => `sha384-${digest("sha384", data, "base64")}`;

async function cliVersion() {
  const pkg = join(here, "..", "packages", "cli", "package.json");
  if (!existsSync(pkg)) return "0.1.0";
  try {
    return JSON.parse(await readFile(pkg, "utf8")).version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const result = await build({
  entryPoints: [join(here, "src", "main.ts")],
  outfile: join(dist, "app.js"),
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

const app = await readFile(join(dist, "app.js"));
const css = await readFile(join(here, "styles.css"));
const favicon = await readFile(join(here, "favicon.svg"));
await writeFile(join(dist, "styles.css"), css);
await writeFile(join(dist, "favicon.svg"), favicon);

const version = await cliVersion();
let html = await readFile(join(here, "index.html"), "utf8");
html = html
  .replaceAll(/agents-room@\d+\.\d+\.\d+[\w.-]*/g, `agents-room@${version}`)
  .replace('src="/app.js"', `src="/app.js?v=${short(app)}" integrity="${sri(app)}"`)
  .replace('href="/styles.css"', `href="/styles.css?v=${short(css)}" integrity="${sri(css)}"`)
  .replace('href="/favicon.svg"', `href="/favicon.svg?v=${short(favicon)}"`);
for (const needle of ["/app.js?v=", "/styles.css?v="]) {
  if (!html.includes(needle)) throw new Error(`index.html: could not rewrite ${needle}`);
}
await writeFile(join(dist, "index.html"), html);

const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `sha256-${digest("sha256", m[1], "base64")}`);
const manifest = {
  cli_version: version,
  files: {
    "index.html": { sha256: digest("sha256", html) },
    "app.js": { sha256: digest("sha256", app), integrity: sri(app), bytes: app.length },
    "styles.css": { sha256: digest("sha256", css), integrity: sri(css), bytes: css.length },
    "favicon.svg": { sha256: digest("sha256", favicon) },
  },
  csp_inline_scripts: inline,
};
await writeFile(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
console.log(`web/dist: app.js ${kb(app.length)}, styles.css ${kb(css.length)}, index.html ${kb(html.length)}`);
if (process.argv.includes("--meta")) console.log(Object.keys(result.metafile.inputs).length, "inputs");
