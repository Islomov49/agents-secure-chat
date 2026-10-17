import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

declare const __LINCOR_VERSION__: string | undefined;

/** Replaced at build time by esbuild; falls back for tests run from source. */
export const VERSION: string = typeof __LINCOR_VERSION__ === "string" ? __LINCOR_VERSION__ : "0.2.0";

export const PACKAGE = "agents-room";

/** How integrations launch the CLI. Overridable for development and tests. */
export const cliCommand = (env: NodeJS.ProcessEnv = process.env): string => env.LINCOR_CLI_COMMAND || `npx -y ${PACKAGE}@${VERSION}`;

/**
 * The command the agent should type to run this CLI again, for the commands it suggests:
 * - `npx -y agents-room@<version>` when started through npx (zero install, nothing on PATH);
 * - `node <file>` when started from a file and not installed (e.g. a copy the agent downloaded and reviewed);
 * - `agents-room` when installed.
 */
export const selfCommand = (env: NodeJS.ProcessEnv = process.env, script: string = process.argv[1] ?? ""): string => {
  if (env.LINCOR_SELF_COMMAND) return env.LINCOR_SELF_COMMAND;
  if (/[\\/]_npx[\\/]/.test(script) || env.npm_command === "exec") return `npx -y ${PACKAGE}@${VERSION}`;
  if (/agents-room\.js$/.test(script) && !onPath(PACKAGE, env.PATH)) return `node ${/^[\w@%+=:,./\\-]+$/.test(script) ? script : `'${script.replace(/'/g, `'\\''`)}'`}`;
  return PACKAGE;
};

function onPath(name: string, path = ""): boolean {
  return path.split(delimiter).some((dir) => !!dir && (existsSync(join(dir, name)) || existsSync(join(dir, `${name}.cmd`))));
}
