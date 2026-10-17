// lincor web app entry. Home ("/", or "/r" without a key) and room ("/r#<key>") are states of one page (FR-12.3).
// The key is read from the fragment, kept in sessionStorage (or localStorage when remembered) and the fragment is
// removed from the address bar (FR-10.4). The fragment never reaches the server.
import { LinkError, parseLink } from "@lincor/core";
import { initHome, showHome } from "./home";
import { closeRoom, currentRoom, initRoom, openRoom } from "./room";
import { MemoryStorage, getCurrent, loadRecord, probe, type Stores } from "./storage";

const session = probe(() => window.sessionStorage);
const stores: Stores = {
  session: session ?? new MemoryStorage(),
  local: probe(() => window.localStorage),
};

const DAMAGED = "This room link is incomplete. Ask the sender to copy the whole link again: the part after # is about 50 characters.";

function linkProblem(e: unknown): string {
  if (e instanceof LinkError && e.reason === "version") return "This room link was made by a newer version of lincor. Reload the page or ask the sender for a new link.";
  return DAMAGED;
}

const isRoomPath = () => location.pathname === "/r" || location.pathname.startsWith("/r/");

function goHome(push: boolean, badLink?: string) {
  closeRoom();
  if (push && location.pathname !== "/") history.pushState(null, "", "/");
  showHome({ badLink });
}

function enterRoom(key: string, secret: Uint8Array, how: "push" | "replace", firstMessage?: string) {
  if (how === "push") history.pushState(null, "", "/r");
  else history.replaceState(null, "", "/r" + location.search);
  openRoom({ key, secret, stores, firstMessage });
}

function route() {
  const fragment = (() => {
    try {
      return decodeURIComponent(location.hash.slice(1)).trim();
    } catch {
      return location.hash.slice(1).trim();
    }
  })();
  if (fragment) {
    try {
      const parsed = parseLink(fragment, location.origin);
      return enterRoom(parsed.key, parsed.secret, "replace");
    } catch (e) {
      // Drop the broken key from the address bar too; it may be most of a secret.
      history.replaceState(null, "", isRoomPath() ? "/r" : location.pathname);
      return goHome(false, linkProblem(e));
    }
  }
  if (isRoomPath()) {
    const roomId = getCurrent(stores);
    const saved = roomId ? loadRecord(stores, roomId) : null;
    if (saved) {
      try {
        const parsed = parseLink(saved.record.key, location.origin);
        if (currentRoom()?.roomId === roomId) return;
        return void openRoom({ key: parsed.key, secret: parsed.secret, stores });
      } catch {
        // fall through to home
      }
    }
  }
  goHome(false);
}

function boot() {
  const note = document.getElementById("agentNote");
  if (note) note.hidden = true;

  initHome({
    stores,
    openCreated: (key, secret, firstMessage) => enterRoom(key, secret, "push", firstMessage),
    openRemembered: (roomId) => {
      const saved = loadRecord(stores, roomId);
      if (!saved) return;
      try {
        const parsed = parseLink(saved.record.key, location.origin);
        enterRoom(parsed.key, parsed.secret, "push");
      } catch {
        showHome({ badLink: DAMAGED });
      }
    },
  });
  initRoom();

  // Dialog close buttons.
  document.addEventListener("click", (e) => {
    const close = (e.target as HTMLElement).closest<HTMLElement>("[data-close]");
    close?.closest("dialog")?.close();
  });
  // Light dismiss: a click on a dialog's backdrop closes it.
  document.querySelectorAll("dialog").forEach((d) =>
    d.addEventListener("click", (e) => {
      if (e.target === d) {
        const r = d.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) d.close();
      }
    }),
  );
  // In-app navigation to home without a reload.
  document.querySelectorAll<HTMLAnchorElement>("[data-home]").forEach((a) =>
    a.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      goHome(true);
    }),
  );

  // A fragment navigation fires popstate and then hashchange. route() strips the fragment on the first one, so
  // hashchange only routes when a fragment is still there (browsers that skip popstate for fragments).
  window.addEventListener("popstate", route);
  window.addEventListener("hashchange", () => {
    if (location.hash.length > 1) route();
  });
  route();
}

boot();
