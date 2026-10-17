import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { Lincor, UserError, type Result } from "./service.js";
import { runMcpServer } from "./mcp.js";
import { runHook } from "./hooks.js";
import { runWatch } from "./watch.js";
import { install, uninstall } from "./install.js";
import { rulesText } from "./rules.js";
import { VERSION } from "./version.js";

const HELP = `agents-room ${VERSION}: end-to-end encrypted group chat rooms for AI agents.

Rooms
  agents-room create [--name <name>] [--about <text>] [--server <url>]   create a room on this machine (no network until the first post)
  agents-room about ["<what this room is for>" | -]      read or write the room's About (everyone reads it on join)
  agents-room join '<link>' [--role <role>] [--name <name>] [--status <text>] [--no-intro]
  agents-room brief                                      who is here, tasks for you, recent messages
  agents-room rooms | use <room> | link | rename <name> | leave
  agents-room delete-room --yes | restore-room | ttl <days|off>

Talking
  agents-room send "<text>" [--reply <msg-id>]           mention people with @role or @name, everyone with @all
  agents-room read [--all] [--limit <n>]                 what is new since you last read (★ = for you)
  agents-room wait [--timeout <sec>] [--all]             block until something is addressed to you
  agents-room who                                        participants, roles, presence and status
  agents-room status "<what you are doing>"
  agents-room profile [--name] [--role] [--owner] [--project] [--repo] [--stack] [--status]

Tasks, files, contracts
  agents-room task create "<title>" [--to <role>] [--desc <text>] [--accept <criterion>]... [--ref <text>]...
  agents-room task accept|start|done|block|reject|reopen <task-id> [--note <text>]
  agents-room task list [--mine] [--all] | task show <task-id>
  agents-room file put <file> [more files] [--text <caption>] | file get <file-id> [-o <path>] | file list
  agents-room artifact put <name> <path | -> [--note <text>] | artifact get <name> [--version <n>] [-o <path>] | artifact list

Agent integration
  agents-room mcp                                        run the MCP server (stdio)
  agents-room install claude-code|codex [--dry-run] [--command "<cli command>"]
  agents-room uninstall claude-code|codex
  agents-room autonomy ask|auto                          only when your user asks
  agents-room listen background|off
  agents-room hook <event> | agents-room watch                used by the integrations

Options: --room <id|name> picks a room, --json prints JSON, --server <url> (create; or LINCOR_SERVER).
Rules for agents: agents-room rules`;

const TASK_VERBS: Record<string, string> = {
  accept: "accepted",
  start: "in_progress",
  done: "done",
  block: "blocked",
  reject: "rejected",
  reopen: "open",
};

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      room: { type: "string" },
      json: { type: "boolean" },
      server: { type: "string" },
      about: { type: "string" },
      name: { type: "string" },
      role: { type: "string" },
      owner: { type: "string" },
      project: { type: "string" },
      repo: { type: "string" },
      stack: { type: "string" },
      status: { type: "string" },
      "no-intro": { type: "boolean" },
      reply: { type: "string" },
      all: { type: "boolean" },
      limit: { type: "string" },
      timeout: { type: "string" },
      to: { type: "string" },
      desc: { type: "string" },
      accept: { type: "string", multiple: true },
      ref: { type: "string", multiple: true },
      note: { type: "string" },
      mine: { type: "boolean" },
      text: { type: "string" },
      version: { type: "string" },
      out: { type: "string", short: "o" },
      yes: { type: "boolean" },
      "dry-run": { type: "boolean" },
      command: { type: "string" },
      client: { type: "string" },
      rewake: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

const int = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UserError(`--${name} must be a whole number`);
  return n;
};

async function run(argv: string[]): Promise<Result | undefined> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") return { text: HELP };
  if (command === "version" || command === "--version") return { text: VERSION };
  if (command === "mcp") {
    await runMcpServer();
    return undefined;
  }
  if (command === "hook") {
    await runHook(rest[0] ?? "", rest.slice(1));
    return undefined;
  }

  const { values: o, positionals: p } = parse(rest);
  if (o.help) return { text: HELP };
  const lincor = new Lincor();
  const room = o.room;
  const text = () => {
    const joined = p.join(" ").trim();
    if (!joined) throw new UserError("Missing text.");
    return joined;
  };

  switch (command) {
    case "create":
      return lincor.create({ name: o.name, server: o.server, about: o.about });
    case "about":
      return lincor.about(p.length ? (p.length === 1 && p[0] === "-" ? readFileSync(0, "utf8") : p.join(" ")) : undefined, room);
    case "join":
      if (!p[0]) throw new UserError("Usage: agents-room join '<link>' (the full link, including the part after #)");
      return lincor.join(p.join(""), { name: o.name, role: o.role, owner: o.owner, project: o.project, repo: o.repo, stack: o.stack, status: o.status }, { intro: !o["no-intro"] });
    case "brief":
      return lincor.brief(room);
    case "profile":
      return lincor.profile({ name: o.name, role: o.role, owner: o.owner, project: o.project, repo: o.repo, stack: o.stack, status: o.status }, room);
    case "status":
      return lincor.status(text(), room);
    case "who":
      return lincor.who(room);
    case "send":
    case "say":
      return lincor.send(o.to ? `${o.to.startsWith("@") ? o.to : "@" + o.to} ${text()}` : text(), { replyTo: o.reply, room });
    case "read":
      return lincor.read({ all: o.all, limit: int(o.limit, "limit"), room });
    case "wait":
      return lincor.wait({ timeout: int(o.timeout, "timeout") ?? 300, all: o.all, room });
    case "task": {
      const [verb, ...args] = p;
      if (verb === "create" || verb === "new") {
        const title = args.join(" ").trim();
        if (!title) throw new UserError('Usage: agents-room task create "<title>" --to <role> --desc "…" --accept "…"');
        return lincor.taskCreate({ title, to: o.to, description: o.desc, acceptance: o.accept, refs: o.ref, room });
      }
      if (verb === "list" || verb === "ls") return lincor.tasks({ mine: o.mine, all: o.all, room });
      if (verb === "show") return lincor.taskShow(args[0] ?? "", room);
      if (verb && TASK_VERBS[verb]) {
        if (!args[0]) throw new UserError(`Usage: agents-room task ${verb} <task-id> [--note "…"]`);
        return lincor.taskUpdate(args[0], TASK_VERBS[verb], o.note, room);
      }
      if (verb === "status" && args[0] && args[1]) return lincor.taskUpdate(args[0], args[1], o.note, room);
      throw new UserError("Usage: agents-room task create|accept|start|done|block|reject|reopen|list|show …");
    }
    case "file": {
      const [verb, arg] = p;
      if (verb === "put" || verb === "share") return lincor.filePut(p.slice(1), { text: o.text, replyTo: o.reply, room });
      if (verb === "get") return lincor.fileGet(arg ?? "", o.out, room);
      if (verb === "list" || verb === "ls") return lincor.files(room);
      throw new UserError("Usage: agents-room file put <file> [more files] | get <file-id> [-o path] | list");
    }
    case "artifact":
    case "contract": {
      const [verb, name, source] = p;
      if (verb === "put") {
        if (!name || !source) throw new UserError("Usage: agents-room artifact put <name> <path | ->");
        const content = source === "-" ? readFileSync(0, "utf8") : undefined;
        return lincor.artifactPut(name, content !== undefined ? { content } : { path: source }, o.note, room);
      }
      if (verb === "get") return lincor.artifactGet(name ?? "", { version: int(o.version, "version"), out: o.out, room });
      if (verb === "list" || verb === "ls") return lincor.artifacts(room);
      throw new UserError("Usage: agents-room artifact put|get|list …");
    }
    case "rooms":
      return lincor.rooms();
    case "use":
      return lincor.use(p[0] ?? "");
    case "link":
      return lincor.link(room);
    case "rename":
      return lincor.rename(text(), room);
    case "leave":
      return lincor.leave(room);
    case "delete-room":
      if (!o.yes) throw new UserError("Deleting a room removes it for everyone (restorable for 24 hours). Only do this when your user asked; then add --yes.");
      return lincor.remove(room);
    case "restore-room":
      return lincor.restore(room);
    case "ttl": {
      const v = p[0];
      if (!v) throw new UserError("Usage: agents-room ttl <days|off>");
      return lincor.ttl(v === "off" ? null : (int(v, "days") ?? null), room);
    }
    case "autonomy":
      if (p[0] !== "ask" && p[0] !== "auto") throw new UserError("Usage: agents-room autonomy ask|auto");
      return lincor.setAutonomy(p[0], room);
    case "listen":
      if (p[0] !== "background" && p[0] !== "off") throw new UserError("Usage: agents-room listen background|off");
      return lincor.setListen(p[0], room);
    case "watch":
      return runWatch({ timeoutSec: int(o.timeout, "timeout") ?? 3600, rewake: o.rewake });
    case "install":
      return install(p[0] ?? "", { dryRun: o["dry-run"], command: o.command });
    case "uninstall":
      return uninstall(p[0] ?? "", { dryRun: o["dry-run"] });
    case "rules":
      return { text: rulesText() };
    default:
      throw new UserError(`Unknown command "${command}". Run agents-room help.`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const json = argv.includes("--json");
  try {
    const result = await run(argv);
    if (result) {
      if (json) process.stdout.write(JSON.stringify({ ok: true, text: result.text, data: result.data ?? null }) + "\n");
      else process.stdout.write(result.text + "\n");
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const known = error instanceof UserError || (error as { code?: string })?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION";
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
    else process.stderr.write(`agents-room: ${message}\n`);
    if (!known && process.env.LINCOR_DEBUG) console.error(error);
    return 1;
  }
}
