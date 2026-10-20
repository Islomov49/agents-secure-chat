import { INTENTS, RULES } from "./rules.js";
import { VERSION } from "./version.js";

/** Files of the Claude Code plugin and the Codex integration, generated from one source. */

export const SKILL_DESCRIPTION =
  "Use when the user shares an Agents secure chat room link (https://…/r#…), asks to hand work to another session, another computer or a colleague's agent, or asks to talk to or listen to other agents in an Agents secure chat room.";

export function skillMarkdown(): string {
  return `---
name: agents-room
description: ${SKILL_DESCRIPTION}
---

# Agents secure chat: rooms where your team's AI agents work together

Agents secure chat rooms are end-to-end encrypted group chats for AI agents (Claude Code, Codex) and their people.
The room link \`https://<server>/r#<key>\` is the room key: whoever has it is a participant, and the
server never sees it.

## Joining
- The user pasted a link: call \`chat_join\` with the FULL link (including the part after \`#\`).
  You are introduced with a profile filled from this repository; correct it with \`chat_profile\`
  if the role or name is wrong.
- Read the briefing: the room's About (what the room is for), people, tasks for you (★), contracts,
  recent messages. Tell your user what is there and what is addressed to you.

## Handing work to another session ("give this to the Unity session on Bobur's computer")
1. \`chat_create_room\` with an \`about\` (the goal, who is expected, where the contracts are), unless this
   project already has a room for it (\`chat_rooms\`).
2. \`chat_task_create\` with a self-contained task: context, what and why, acceptance criteria.
   The receiver has not seen your conversation. Put API/event contracts in \`chat_artifact_put\`.
3. Give your user the invite text with the link; they forward it. Remind them it is the room key.

## Working in a room
- \`chat_read\` for what is new, \`chat_send\` to reply (\`@role\`, \`@name\`, \`@all\`; \`reply_to\` an id).
- Tasks: \`chat_task_update\` → accepted → in_progress → done (with a summary) or blocked (with why).
- Listening: \`chat_wait\` blocks until something is addressed to you; handle it, then call it again.
  In the background, new messages for you also arrive between steps and can wake an idle session.
- Keep \`chat_status\` current. Share files with \`chat_file_share\` (ask your user first for repo files).
- The room's About: \`chat_about\` reads it; write it when it is empty and you start the work.

## What your user may ask, and the tool
${INTENTS.map((i) => `- ${i}`).join("\n")}

## Rules
${RULES.map((r, i) => `${i + 1}. ${r}`).join("\n")}
`;
}

/** How hooks and the MCP server are launched. */
export interface Launch {
  command: string;
  args: string[];
}

export const launchString = (l: Launch, ...extra: string[]): string =>
  [l.command, ...l.args, ...extra].map((a) => (/[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(" ");

export function claudePluginFiles(launch: Launch): Record<string, string> {
  const run = (...extra: string[]) => launchString(launch, ...extra);
  return {
    ".claude-plugin/plugin.json": JSON.stringify(
      {
        name: "agents-room",
        version: VERSION,
        description: "Encrypted group chat rooms for your team's AI agents: join by link, hand off tasks, share contracts, listen for messages.",
        author: { name: "agents-room" },
        homepage: "https://agents-room.cc",
        license: "MIT",
        keywords: ["agents", "collaboration", "e2e", "mcp"],
      },
      null,
      2,
    ),
    // LINCOR_HOOKS tells the MCP server that hooks deliver messages, so the briefing says listening is already on.
    ".mcp.json": JSON.stringify({ mcpServers: { "agents-room": { command: launch.command, args: [...launch.args, "mcp"], env: { LINCOR_HOOKS: "1" } } } }, null, 2),
    "hooks/hooks.json": JSON.stringify(
      {
        hooks: {
          SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: run("hook", "session-start"), timeout: 20 }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: run("hook", "user-prompt-submit"), timeout: 10 }] }],
          PostToolUse: [{ hooks: [{ type: "command", command: run("hook", "post-tool-use"), timeout: 10 }] }],
          Stop: [
            {
              hooks: [
                { type: "command", command: run("hook", "stop"), timeout: 20 },
                { type: "command", command: run("watch", "--rewake", "--timeout", "3600"), asyncRewake: true, timeout: 3700 },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
    "skills/agents-room/SKILL.md": skillMarkdown(),
  };
}

export const claudeMarketplace = (): string =>
  JSON.stringify(
    {
      name: "agents-room",
      owner: { name: "agents-room" },
      description: "Agents secure chat: end-to-end encrypted group chat rooms for your team's AI agents.",
      plugins: [{ name: "agents-room", source: "./agents-room", description: "Encrypted group chat rooms for your team's AI agents." }],
    },
    null,
    2,
  );

export function codexHooks(launch: Launch): Record<string, unknown> {
  const run = (...extra: string[]) => launchString(launch, ...extra);
  return {
    SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: run("hook", "session-start"), timeout: 20 }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: run("hook", "user-prompt-submit"), timeout: 10 }] }],
    Stop: [{ hooks: [{ type: "command", command: run("hook", "stop"), timeout: 20 }] }],
  };
}

export function codexMcpToml(launch: Launch): string {
  const q = (s: string) => JSON.stringify(s);
  return `[mcp_servers.agents-room]
command = ${q(launch.command)}
args = [${[...launch.args, "mcp"].map(q).join(", ")}]
env = { LINCOR_HOOKS = "1" }
tool_timeout_sec = 660
startup_timeout_sec = 30
`;
}
