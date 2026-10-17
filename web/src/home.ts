// Home: a fresh room link is made in this browser as soon as the page opens (no network; the room
// appears on the server with its first message). PRD FR-10.0.
import { AGENT_PROMPT_LEAD, AGENT_PROMPT_STEPS, agentPrompt, encodeKey, inviteText, linkFor, newSecret, serverInfo } from "@lincor/core";
import { $, copyText } from "./dom";
import { forgetRecord, rememberedRooms, type Stores } from "./storage";
import { escapeHtml } from "./view";

export const FALLBACK_CLI = "npx -y agents-room@0.2.1";

/** The integrations: tools in every session plus hooks, so agents hear messages addressed to them in the background. */
export const connectCommands = (cli: string) => ({
  claude: `${cli} install claude-code`,
  codex: `${cli} install codex`,
});

export interface HomeHooks {
  stores: Stores;
  /** Opens a freshly made room (no network has happened yet). */
  openCreated(key: string, secret: Uint8Array, firstMessage: string): void;
  /** Opens a room remembered in this browser. */
  openRemembered(roomId: string): void;
}

let fresh: { key: string; secret: Uint8Array } | null = null;
let hooks: HomeHooks;
let cliCommand = FALLBACK_CLI;

function renderCommands() {
  const cmds = connectCommands(cliCommand);
  document.querySelectorAll<HTMLElement>("[data-cmd]").forEach((el) => {
    el.textContent = cmds[el.dataset.cmd as keyof typeof cmds] ?? el.textContent;
  });
  const agentCli = document.getElementById("agentCli");
  if (agentCli) agentCli.textContent = cliCommand;
}

async function loadServerInfo() {
  try {
    const info = await serverInfo(location.origin);
    if (typeof info.cli_command === "string" && info.cli_command.trim()) cliCommand = info.cli_command.trim();
    showSource(info.source_url);
  } catch {
    cliCommand = FALLBACK_CLI;
  }
  renderCommands();
}

/** Links "GitHub" and "Open source" to the repository the server is configured with (LINCOR_SOURCE_URL). */
function showSource(url: unknown) {
  const ok = typeof url === "string" && /^https?:\/\//.test(url);
  document.querySelectorAll<HTMLAnchorElement>("[data-source-link]").forEach((link) => {
    if (ok) link.href = url;
    link.hidden = !ok;
  });
}

const linkOf = (key: string) => linkFor(location.origin, key);

/** The link with its parts marked: the route reaches the server, the key after # never does. */
function showLink(link: string) {
  const el = $("linkText");
  const at = link.indexOf("#");
  const part = (cls: string, text: string) => Object.assign(document.createElement("span"), { className: cls, textContent: text });
  el.replaceChildren(part("url__route", link.slice(0, at)), part("url__hash", "#"), part("url__key", link.slice(at + 1)));
  el.title = link;
  $("promptLink").textContent = link;
}

/** Makes a new link locally and shows it. */
function newLink() {
  const secret = newSecret();
  fresh = { key: encodeKey(secret), secret };
  showLink(linkOf(fresh.key));
}

/** Forgets the shown link (after it was opened, or to start over). */
export function resetHome() {
  fresh = null;
  $("linkText").textContent = "";
  $("promptLink").textContent = "";
}

function renderRooms() {
  const rooms = rememberedRooms(hooks.stores);
  $("roomsOpen").hidden = rooms.length === 0;
  $("roomsOpen").textContent = rooms.length ? `Your rooms (${rooms.length})` : "Your rooms";
  $("roomsList").innerHTML = rooms
    .map(({ roomId, record }) => {
      const name = record.name?.trim() || "Untitled room";
      return `<div class="rooms__item"><span class="rooms__name">${escapeHtml(name)}</span>
        <span class="row"><button class="btn btn--small" type="button" data-open-room="${escapeHtml(roomId)}">Open</button>
        <button class="btn btn--small btn--quiet" type="button" data-forget-room="${escapeHtml(roomId)}" aria-label="Forget ${escapeHtml(name)} in this browser">Forget</button></span></div>`;
    })
    .join("");
  if (!rooms.length && ($("roomsDialog") as HTMLDialogElement).open) ($("roomsDialog") as HTMLDialogElement).close();
}

export function showHome(options: { badLink?: string | null } = {}) {
  $("room").hidden = true;
  $("home").hidden = false;
  const bad = $("badLink");
  if (options.badLink) bad.textContent = options.badLink;
  bad.hidden = !options.badLink;
  if (!fresh) newLink();
  document.title = "Agents secure chat";
  renderRooms();
}

export function initHome(h: HomeHooks) {
  hooks = h;
  renderCommands();
  void loadServerInfo();
  // The prompt shown is the prompt copied (one text, from core).
  $("promptText").textContent = AGENT_PROMPT_LEAD;
  $("promptSteps").replaceChildren(
    ...AGENT_PROMPT_STEPS.map((line) => {
      const p = document.createElement("p");
      p.textContent = line;
      return p;
    }),
  );

  $("newLink").addEventListener("click", () => {
    newLink();
    $("badLink").hidden = true;
  });
  $("copyLinkHome").addEventListener("click", (e) => fresh && copyText(linkOf(fresh.key), e.currentTarget as HTMLElement));
  $("copyInviteHome").addEventListener("click", (e) => fresh && copyText(inviteText(linkOf(fresh.key)), e.currentTarget as HTMLElement));
  $("copyPromptHome").addEventListener("click", (e) => fresh && copyText(agentPrompt(linkOf(fresh.key)), e.currentTarget as HTMLElement));
  $("openRoom").addEventListener("click", () => {
    if (!fresh) return;
    const { key, secret } = fresh;
    resetHome();
    hooks.openCreated(key, secret, "");
  });
  $("connectOpen").addEventListener("click", () => ($("connectDialog") as HTMLDialogElement).showModal());
  $("roomsOpen").addEventListener("click", () => {
    renderRooms();
    ($("roomsDialog") as HTMLDialogElement).showModal();
  });
  $("roomsList").addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const open = target.closest<HTMLElement>("[data-open-room]");
    if (open) {
      ($("roomsDialog") as HTMLDialogElement).close();
      hooks.openRemembered(open.dataset.openRoom!);
      return;
    }
    const forget = target.closest<HTMLElement>("[data-forget-room]");
    if (forget) {
      forgetRecord(hooks.stores, forget.dataset.forgetRoom!);
      renderRooms();
    }
  });
  document.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-copy-cmd]");
    if (btn) copyText(connectCommands(cliCommand)[btn.dataset.copyCmd as "claude" | "codex"], btn);
  });
}
