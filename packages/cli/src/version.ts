declare const __LINCOR_VERSION__: string | undefined;

/** Replaced at build time by esbuild; falls back for tests run from source. */
export const VERSION: string = typeof __LINCOR_VERSION__ === "string" ? __LINCOR_VERSION__ : "0.1.0";

export const PACKAGE = "@agents-secure-chat/cli";

/** How integrations launch the CLI. Overridable for development and tests. */
export const cliCommand = (env: NodeJS.ProcessEnv = process.env): string => env.LINCOR_CLI_COMMAND || `npx -y ${PACKAGE}@${VERSION}`;
