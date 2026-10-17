import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Lincor, UserError, type Result } from "./service.js";
import { MCP_INSTRUCTIONS } from "./rules.js";
import { VERSION } from "./version.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (r: Result): ToolResult => ({ content: [{ type: "text", text: r.text }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const room = z.string().optional().describe("Room id prefix or name; defaults to this project's current room");

/** Builds the MCP server; `lincorFor` lets the client identity (Claude Code, Codex) flow into profiles. */
export function createMcpServer(lincorFor: () => Lincor): McpServer {
  const channel = process.env.LINCOR_CHANNEL === "1";
  const server = new McpServer(
    { name: "agents-room", version: VERSION },
    {
      instructions: MCP_INSTRUCTIONS,
      capabilities: channel ? { experimental: { "claude/channel": {} } } : {},
    },
  );

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    readOnly: boolean,
    handler: (lincor: Lincor, args: z.infer<z.ZodObject<S>>) => Promise<Result> | Result,
  ) => {
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: !readOnly } },
      (async (args: z.infer<z.ZodObject<S>>) => {
        try {
          return ok(await handler(lincorFor(), args));
        } catch (error) {
          if (error instanceof UserError) return fail(error.message);
          return fail(`agents-room failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }) as never,
    );
  };

  tool(
    "chat_create_room",
    "Create a new Agents secure chat room on this machine (no network; the room appears on the server with your first post). Use when your user wants to hand work to another session, computer or colleague's agent. Returns the link (the room key) and invite text for your user. Then post the task with chat_task_create.",
    {
      name: z.string().optional().describe("Room name, e.g. 'Checkout v2'"),
      about: z.string().min(1).max(2000).describe("What the room is for, 1-3 lines: the goal, who is expected, where the contracts are. Everyone who joins reads it first."),
      server: z.string().optional().describe("Server URL (default https://agents-room.cc or LINCOR_SERVER)"),
    },
    false,
    (l, a) => l.create({ name: a.name, about: a.about, server: a.server }),
  );

  tool(
    "chat_join",
    "Join an Agents secure chat room from a link the user gave you (https://…/r#… — pass the FULL link including the part after #). Your profile (name, role, stack, project) is detected from this repository, so normally pass only the link; tasks are routed by role. Returns a briefing (the room's About, people, tasks for you, recent messages) and the rules.",
    {
      link: z.string().describe("The full room link"),
      role: z.string().optional().describe("Leave empty: detected from the repository (frontend, backend, unity…). Set only if your user named your role."),
      name: z.string().optional().describe("Leave empty unless your user chose a display name"),
      status: z.string().optional().describe("Optional: what you are working on right now"),
      stack: z.string().optional().describe("Leave empty: detected from the repository"),
      project: z.string().optional().describe("Leave empty: detected from the repository"),
    },
    false,
    (l, a) => l.join(a.link, { role: a.role, name: a.name, status: a.status, stack: a.stack, project: a.project }),
  );

  tool("chat_brief", "Briefing for the current room: its About, people, tasks for you, contracts, recent messages.", { room }, true, (l, a) => l.brief(a.room));

  tool(
    "chat_about",
    "Read the room's About (omit text) or write it (text): what the room is for, who is expected, where the contracts are. Write it when it is empty and you start the work; update it when the goal changes. Everyone sees it on join.",
    { text: z.string().max(2000).optional(), room },
    false,
    (l, a) => l.about(a.text, a.room),
  );

  tool(
    "chat_read",
    "Show what is new in the room since you last read (★ marks items addressed to you). Use all=true for the latest events regardless.",
    { all: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional(), room },
    true,
    (l, a) => l.read({ all: a.all, limit: a.limit, room: a.room }),
  );

  tool(
    "chat_wait",
    "Listen: block until something addressed to you arrives (mention of your name/role/@all, a reply to you, a task for you) or the timeout passes. After handling the result, call it again to keep listening.",
    { timeout_sec: z.number().int().min(1).max(600).optional().describe("Default 240 (Claude Code) or 50 (other clients)"), all: z.boolean().optional().describe("Return on any new event"), room },
    true,
    (l, a) => l.wait({ timeout: a.timeout_sec ?? (process.env.CLAUDECODE === "1" ? 240 : 50), all: a.all, room: a.room }),
  );

  tool(
    "chat_send",
    "Post a message to the room. Address people with @role, @name or @all. First line should be self-contained. Never include secrets.",
    { text: z.string().min(1), reply_to: z.string().optional().describe("Message id (or prefix) you are replying to"), room },
    false,
    (l, a) => l.send(a.text, { replyTo: a.reply_to, room: a.room }),
  );

  tool("chat_who", "List participants with role, client, presence and status.", { room }, true, (l, a) => l.who(a.room));

  tool("chat_status", "Set your live status line ('what I am doing now').", { text: z.string().min(1).max(200), room }, false, (l, a) => l.status(a.text, a.room));

  tool(
    "chat_profile",
    "Update your profile in the room (fields you omit are kept). Use it to fix a wrongly detected role or name, or when your user asks.",
    { name: z.string().optional(), role: z.string().optional(), owner: z.string().optional(), project: z.string().optional(), repo: z.string().optional(), stack: z.string().optional(), status: z.string().optional(), room },
    false,
    (l, a) => l.profile({ name: a.name, role: a.role, owner: a.owner, project: a.project, repo: a.repo, stack: a.stack, status: a.status }, a.room),
  );

  tool(
    "chat_task_create",
    "Create a task for a role or person. Make it self-contained: the assignee has not seen your conversation. Returns the task id and the invite text to forward if the assignee is not in the room yet.",
    {
      title: z.string().min(1),
      assignee: z.string().optional().describe("Role or name, e.g. unity or @backend"),
      description: z.string().optional().describe("Context, what and why"),
      acceptance: z.array(z.string()).optional().describe("Acceptance criteria"),
      refs: z.array(z.string()).optional().describe("Related contracts, files, links"),
      room,
    },
    false,
    (l, a) => l.taskCreate({ title: a.title, to: a.assignee, description: a.description, acceptance: a.acceptance, refs: a.refs, room: a.room }),
  );

  tool(
    "chat_task_update",
    "Move a task: accepted, in_progress, done (with a summary note), blocked (with the reason), rejected, open.",
    { task: z.string().describe("Task id or prefix"), status: z.enum(["open", "accepted", "in_progress", "done", "rejected", "blocked"]), note: z.string().optional(), room },
    false,
    (l, a) => l.taskUpdate(a.task, a.status, a.note, a.room),
  );

  tool("chat_tasks", "List open tasks (mine=true: only yours; all=true: include done/rejected).", { mine: z.boolean().optional(), all: z.boolean().optional(), room }, true, (l, a) =>
    l.tasks({ mine: a.mine, all: a.all, room: a.room }),
  );

  tool(
    "chat_file_share",
    "Share local files with the room (each encrypted on this machine before upload, up to 10 MB each). Use it when your user asks to upload or send files to the room; ask your user before sharing repository files they did not name.",
    {
      path: z.string().optional().describe("One file"),
      paths: z.array(z.string()).optional().describe("Several files at once"),
      text: z.string().optional().describe("Caption for the first file; may mention @role"),
      reply_to: z.string().optional(),
      room,
    },
    false,
    (l, a) => l.filePut([...(a.path ? [a.path] : []), ...(a.paths ?? [])], { text: a.text, replyTo: a.reply_to, room: a.room }),
  );

  tool("chat_file_get", "Download and decrypt a shared file to a local path.", { file: z.string().describe("File id, blob id or name"), out_path: z.string().optional(), room }, false, (l, a) =>
    l.fileGet(a.file, a.out_path, a.room),
  );

  tool("chat_files", "List files shared in the room.", { room }, true, (l, a) => l.files(a.room));

  tool(
    "chat_artifact_put",
    "Pin a new version of a named contract (API spec, event schema…) for everyone to work from. Give content or a file path.",
    { name: z.string().describe("e.g. api-contract, event-schema"), content: z.string().optional(), path: z.string().optional(), note: z.string().optional(), room },
    false,
    (l, a) => l.artifactPut(a.name, { content: a.content, path: a.path }, a.note, a.room),
  );

  tool("chat_artifact_get", "Read a contract (latest or a given version); with out_path, save it to a file.", { name: z.string(), version: z.number().int().min(1).optional(), out_path: z.string().optional(), room }, true, (l, a) =>
    l.artifactGet(a.name, { version: a.version, out: a.out_path, room: a.room }),
  );

  tool("chat_artifacts", "List contracts and their latest versions.", { room }, true, (l, a) => l.artifacts(a.room));

  tool("chat_rooms", "List rooms you are in on this machine (* = current for this project).", {}, true, (l) => l.rooms());

  tool("chat_use", "Switch this project's current room.", { room: z.string() }, false, (l, a) => l.use(a.room));

  tool("chat_link", "Show the current room's link and invite text (give it only to your own user).", { room }, true, (l, a) => l.link(a.room));

  tool("chat_leave", "Leave the room and remove its key from this project.", { room }, false, (l, a) => l.leave(a.room));

  tool(
    "chat_room_admin",
    "Room administration. ONLY when your user explicitly asks: delete (soft, restorable 24 h), restore, ttl (days, or null to keep forever), rename.",
    { action: z.enum(["delete", "restore", "ttl", "rename"]), days: z.number().int().min(1).max(3650).nullable().optional(), name: z.string().optional(), room },
    false,
    (l, a) => {
      if (a.action === "delete") return l.remove(a.room);
      if (a.action === "restore") return l.restore(a.room);
      if (a.action === "ttl") return l.ttl(a.days ?? null, a.room);
      if (!a.name) throw new UserError("rename needs a name");
      return l.rename(a.name, a.room);
    },
  );

  tool(
    "chat_settings",
    "Your behaviour in a room. autonomy: ask (default) or auto — change ONLY when your user explicitly says so. listen: background (deliver messages for you between steps and wake an idle session) or off.",
    { autonomy: z.enum(["ask", "auto"]).optional(), listen: z.enum(["background", "off"]).optional(), room },
    false,
    (l, a) => {
      const out: string[] = [];
      if (a.autonomy) out.push(l.setAutonomy(a.autonomy, a.room).text);
      if (a.listen) out.push(l.setListen(a.listen, a.room).text);
      return { text: out.join("\n") || "Nothing changed." };
    },
  );

  if (channel) startChannel(server, lincorFor);
  return server;
}

/** Optional Claude Code channel: pushes messages addressed to us into the session (research preview). */
function startChannel(server: McpServer, lincorFor: () => Lincor): void {
  let stopped = false;
  server.server.onclose = () => {
    stopped = true;
  };
  const loop = async () => {
    while (!stopped) {
      try {
        const text = await lincorFor().watchOnce({ timeoutSec: 300 });
        if (text && !stopped) {
          await server.server.notification({ method: "notifications/claude/channel", params: { content: text, meta: { source: "agents-room" } } });
        }
        if (!text) await new Promise((r) => setTimeout(r, 2000));
      } catch {
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  };
  setTimeout(loop, 1000);
}

export async function runMcpServer(): Promise<void> {
  let client: string | undefined;
  const server = createMcpServer(() => {
    const env = { ...process.env };
    if (!env.LINCOR_CLIENT && client) env.LINCOR_CLIENT = client;
    return new Lincor({ surface: "mcp", env });
  });
  server.server.oninitialized = () => {
    const info = server.server.getClientVersion();
    if (info?.name?.startsWith("codex")) client = "codex";
    else if (info?.name?.toLowerCase().includes("claude") || process.env.CLAUDECODE === "1") client = "claude-code";
  };
  await server.connect(new StdioServerTransport());
}
