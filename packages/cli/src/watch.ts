import { randomBytes } from "node:crypto";
import { Lincor, type Result } from "./service.js";

/**
 * Headless runs (`claude -p`, the Agent SDK) wait for async hooks before exiting, and there is no idle
 * session to wake there. Claude Code marks them with CLAUDE_CODE_SESSION_ATTENDED=0 and an `sdk-*`
 * entrypoint (observed in 2.1.29x; not documented, so both are checked).
 */
export function isUnattended(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODE_SESSION_ATTENDED === "0" || /^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT ?? "");
}

/**
 * `agents-secure-chat watch`: waits for messages addressed to this project's agent in listening rooms.
 * With --rewake (a Claude Code `asyncRewake` Stop hook) it exits with code 2 and writes the messages to
 * stderr, which wakes an idle session. A newer watcher for the same session supersedes older ones,
 * so re-arming on every Stop never wakes the session twice for one message.
 */
export async function runWatch(options: { timeoutSec: number; rewake?: boolean }): Promise<Result | undefined> {
  if (options.rewake && isUnattended()) process.exit(0);
  let sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? "default";
  let cwd = process.cwd();
  if (options.rewake && !process.stdin.isTTY) {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      sessionId = input.session_id ?? sessionId;
      cwd = input.cwd ?? cwd;
    } catch {
      // no hook input
    }
  }
  const lincor = new Lincor({ cwd, surface: options.rewake ? "mcp" : "cli" });
  const state = lincor.store.hookState<{ watcher?: string }>(`watch:${sessionId}`);
  const token = randomBytes(8).toString("hex");
  state.set({ watcher: token });
  if (options.rewake) await new Promise((r) => setTimeout(r, 3000)); // let the synchronous Stop hook go first

  let text: string | null = null;
  try {
    text = await lincor.watchOnce({ timeoutSec: options.timeoutSec, superseded: () => state.get()?.watcher !== token });
  } catch {
    text = null;
  }
  if (!options.rewake) return { text: text ?? `Nothing addressed to you within ${options.timeoutSec}s.` };
  if (text && state.get()?.watcher === token) {
    process.stderr.write(text + "\n");
    process.exit(2);
  }
  process.exit(0);
}
