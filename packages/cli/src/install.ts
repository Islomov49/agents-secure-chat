import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError, type Result } from "./service.js";
import { lincorHome } from "./store.js";
import { claudeMarketplace, claudePluginFiles, codexHooks, codexMcpToml, skillMarkdown, type Launch } from "./templates.js";

interface InstallOptions {
  dryRun?: boolean;
  /** Command used to launch lincor, e.g. "npx -y agents-room@0.1.0" or "node /path/agents-room.js". */
  command?: string;
}

/** The Claude Code CLI used to register the plugin; LINCOR_CLAUDE_BIN points elsewhere (another install, tests). */
const claudeBin = (): string => process.env.LINCOR_CLAUDE_BIN || "claude";

const which = (bin: string): boolean => {
  if (bin.includes("/") || bin.includes("\\")) return existsSync(bin);
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/**
 * Integrations run a private copy of this CLI bundle (fast: no npx on every hook) unless --command is given.
 */
function launchFor(dir: string, options: InstallOptions, dryRun: boolean): Launch {
  if (options.command) {
    const parts = options.command.trim().split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }
  const bundle = fileURLToPath(import.meta.url);
  const target = join(dir, "bin", "agents-room.js");
  if (!dryRun && bundle.endsWith(".js") && existsSync(bundle)) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(bundle, target);
  }
  return { command: "node", args: [target] };
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content.endsWith("\n") ? content : content + "\n");
  }
}

const run = (bin: string, args: string[]): string => execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export async function install(target: string, options: InstallOptions = {}): Promise<Result> {
  if (target === "claude-code" || target === "claude") return installClaude(options);
  if (target === "codex") return installCodex(options);
  throw new UserError("Usage: agents-room install claude-code|codex [--dry-run] [--command \"<how to run lincor>\"]");
}

export async function uninstall(target: string, options: { dryRun?: boolean } = {}): Promise<Result> {
  if (target === "claude-code" || target === "claude") {
    const steps = ["claude plugin uninstall agents-room@agents-room", "claude plugin marketplace remove agents-room"];
    if (!options.dryRun && which(claudeBin())) {
      for (const s of steps) {
        try {
          run(claudeBin(), s.split(" ").slice(1));
        } catch {
          // already removed
        }
      }
      rmSync(join(lincorHome(), "integrations", "claude-code"), { recursive: true, force: true });
    }
    return { text: `${options.dryRun ? "Would run" : "Ran"}:\n${steps.join("\n")}` };
  }
  if (target === "codex") {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    if (!options.dryRun) {
      removeTomlSection(join(codexHome, "config.toml"), "mcp_servers.agents-room");
      rmSync(join(codexHome, "skills", "agents-room"), { recursive: true, force: true });
      editHooks(join(codexHome, "hooks.json"), () => ({}));
      rmSync(join(lincorHome(), "integrations", "codex"), { recursive: true, force: true });
    }
    return { text: `${options.dryRun ? "Would remove" : "Removed"} the Agents secure chat MCP server, skill and hooks from ${codexHome}.` };
  }
  throw new UserError("Usage: agents-room uninstall claude-code|codex");
}

function installClaude(options: InstallOptions): Result {
  const root = join(lincorHome(), "integrations", "claude-code");
  const pluginDir = join(root, "agents-room");
  const dryRun = !!options.dryRun;
  const launch = launchFor(pluginDir, options, dryRun);
  const files = { ...prefix("agents-room/", claudePluginFiles(launch)), ".claude-plugin/marketplace.json": claudeMarketplace() };
  const steps = [`claude plugin marketplace add ${root}`, "claude plugin install agents-room@agents-room --scope user"];
  if (dryRun) {
    return { text: `Would write a Claude Code plugin to ${root}:\n${Object.keys(files).map((f) => "  " + f).join("\n")}\nand run:\n${steps.join("\n")}` };
  }
  writeFiles(root, files);
  if (!which(claudeBin())) {
    return { text: `Wrote the plugin to ${root}. The claude CLI was not found; install it with:\n${steps.join("\n")}` };
  }
  const log: string[] = [];
  try {
    run(claudeBin(), ["plugin", "marketplace", "remove", "agents-room"]);
  } catch {
    // not added before
  }
  log.push(run(claudeBin(), ["plugin", "marketplace", "add", root]));
  log.push(run(claudeBin(), ["plugin", "install", "agents-room@agents-room", "--scope", "user"]));
  return {
    text: `Installed the Agents secure chat plugin for Claude Code (MCP tools, skill, hooks for background listening).\nRestart Claude Code sessions (or run /reload-plugins) to load it.\n${log.filter(Boolean).join("\n")}`,
  };
}

function installCodex(options: InstallOptions): Result {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const dir = join(lincorHome(), "integrations", "codex");
  const dryRun = !!options.dryRun;
  const launch = launchFor(dir, options, dryRun);
  const configPath = join(codexHome, "config.toml");
  const hooksPath = join(codexHome, "hooks.json");
  const skillPath = join(codexHome, "skills", "agents-room", "SKILL.md");
  if (dryRun) {
    return {
      text: `Would update ${configPath} with:\n${codexMcpToml(launch)}\nwrite ${skillPath}\nand add Agents secure chat hooks to ${hooksPath}.`,
    };
  }
  mkdirSync(codexHome, { recursive: true });
  if (existsSync(configPath)) copyFileSync(configPath, configPath + ".lincor-backup");
  removeTomlSection(configPath, "mcp_servers.agents-room");
  const before = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  writeFileSync(configPath, (before && !before.endsWith("\n") ? before + "\n" : before) + "\n" + codexMcpToml(launch));
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, skillMarkdown());
  editHooks(hooksPath, () => codexHooks(launch));
  return {
    text: [
      "Installed Agents secure chat for Codex:",
      `- MCP server "agents-room" in ${configPath} (tool timeout 11 min for chat_wait; backup at config.toml.lincor-backup)`,
      `- skill ${skillPath}`,
      `- hooks in ${hooksPath} (session start briefing, messages on each prompt, Stop keeps you going when messages for you are pending)`,
      "Codex runs new hooks only after you trust them: open Codex and run /hooks once.",
    ].join("\n"),
  };
}

function prefix(p: string, files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [p + k, v]));
}

/** Removes a `[section]` (and its sub-tables) from a TOML file without touching anything else. */
export function removeTomlSection(path: string, section: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/);
    if (header) skipping = header[1] === section || header[1].startsWith(section + ".");
    if (!skipping) out.push(line);
  }
  writeFileSync(path, out.join("\n").replace(/\n{3,}/g, "\n\n"));
}

/** Replaces lincor's entries in a hooks.json while keeping everyone else's. */
export function editHooks(path: string, ours: () => Record<string, unknown>): void {
  let doc: { hooks?: Record<string, { hooks?: { command?: string }[] }[]> } = {};
  if (existsSync(path)) {
    try {
      doc = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new UserError(`${path} is not valid JSON; fix it before installing.`);
    }
  }
  const hooks = doc.hooks ?? {};
  const isOurs = (group: { hooks?: { command?: string }[] }) => (group.hooks ?? []).some((h) => /(agents-room(\.js)?|agents-room@\S+|lincor(\.js)?)['"]?\s+(hook|watch)\b/.test(h.command ?? ""));
  for (const event of Object.keys(hooks)) {
    hooks[event] = hooks[event].filter((g) => !isOurs(g));
    if (!hooks[event].length) delete hooks[event];
  }
  for (const [event, groups] of Object.entries(ours())) {
    hooks[event] = [...(hooks[event] ?? []), ...(groups as never[])];
  }
  doc.hooks = hooks;
  if (!Object.keys(hooks).length && !existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
}
