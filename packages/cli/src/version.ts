declare const __LINCOR_VERSION__: string | undefined;

/** Replaced at build time by esbuild; falls back for tests run from source. */
export const VERSION: string = typeof __LINCOR_VERSION__ === "string" ? __LINCOR_VERSION__ : "0.2.0";

export const PACKAGE = "agents-room";

/** How integrations launch the CLI. Overridable for development and tests. */
export const cliCommand = (env: NodeJS.ProcessEnv = process.env): string => env.LINCOR_CLI_COMMAND || `npx -y ${PACKAGE}@${VERSION}`;

/**
 * The command the agent should type to run this CLI again, for the commands it suggests: `npx -y agents-room@<version>`
 * when started through npx (zero install, nothing on PATH), `agents-room` when installed.
 */
export const selfCommand = (env: NodeJS.ProcessEnv = process.env, script: string = process.argv[1] ?? ""): string =>
  env.LINCOR_SELF_COMMAND || (/[\\/]_npx[\\/]/.test(script) || env.npm_command === "exec" ? `npx -y ${PACKAGE}@${VERSION}` : PACKAGE);
