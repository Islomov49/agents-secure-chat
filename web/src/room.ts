// Room: read without joining, post as a person after a one-time name prompt, live updates, tasks, contracts,
// files and room settings (PRD FR-10.1..10.5, §4.11). All protocol work goes through RoomSession from @lincor/core.
import {
  ApiError,
  BROADCAST_HANDLES,
  FileIntegrityError,
  MAX_FILE_BYTES,
  RoomSession,
  b64u,
  deriveRoom,
  fromB64u,
  handlesFor,
  identityFromSeed,
  inviteText,
  newIdentity,
  utf8,
  type PresenceEntry,
  type RoomEvent,
  type TaskStatus,
} from "@lincor/core";
import { $, announce, copyText, replaceHtml, saveBytes, toast } from "./dom";
import { Live, type EventSource, type LiveStats } from "./live";
import { announcementFor, contractsHtml, emptyFeedHtml, feedHtml, filesHtml, nameOf, peopleHtml, tasksHtml, type RenderContext } from "./render";
import { loadRecord, saveRecord, setCurrent, type RoomRecord, type Stores } from "./storage";
import {
  STATUS_LABEL,
  artifactFileName,
  backoffDelay,
  escapeHtml,
  feedItems,
  formatBytes,
  hasConversation,
  parseTaskInput,
  roomTitle,
  safeFileName,
  ttlLabel,
  untilLabel,
  whenLabel,
} from "./view";

type View = "chat" | "people" | "tasks" | "contracts" | "files";
type SideTab = "tasks" | "contracts" | "files";

export interface OpenRoomOptions {
  key: string;
  secret: Uint8Array;
  stores: Stores;
  /** Text from the home page's "First message" field; posted after the name prompt. */
  firstMessage?: string;
}

/** Debug surface for tests: which path live updates use and arrived on. */
interface LincorDebug {
  transport: "ws" | "poll" | "none";
  eventsVia: Record<EventSource, number>;
  live?: LiveStats;
  lastSeq?: number;
  rejected?: number;
}
declare global {
  interface Window {
    __lincorTransport?: "ws" | "poll" | "none";
    __lincor?: LincorDebug;
  }
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "room_deleted":
        return "This room is deleted. Restore it to post again.";
      case "too_large":
        return "That is too large for the server.";
      case "rate_limited":
        return `Too many requests. Try again in ${e.retryAfter ?? 30} seconds.`;
      case "room_full":
        return "This room is full.";
      case "quota_exceeded":
        return "This room is out of storage space.";
      case "auth":
        return "The server did not accept this browser's signature. Check that the device clock is right.";
    }
    return e.message;
  }
  if (e instanceof FileIntegrityError) return "This file failed its integrity check, so it was not saved.";
  if (e instanceof TypeError) return "Can't reach lincor. Check your connection and try again.";
  return e instanceof Error ? e.message : String(e);
}

const narrow = () => matchMedia("(max-width: 760px)").matches;
const input = () => $<HTMLTextAreaElement>("composerInput");

class RoomController {
  readonly session: RoomSession;
  readonly live: Live;
  readonly roomId: string;
  private record: RoomRecord;
  private remembered: boolean;
  private presence = new Map<string, PresenceEntry>();
  private stopped = false;
  private loaded = false;
  private loadError = "";
  private renderQueued = false;
  private forceBottom = true;
  private tick?: ReturnType<typeof setInterval>;
  private unread = 0;
  private debug: LincorDebug = { transport: "none", eventsVia: { ws: 0, poll: 0, sync: 0 } };

  mode: "message" | "task" = "message";
  view: View = "chat";
  sideTab: SideTab = "tasks";
  replyTo?: string;
  pendingFile?: File;
  pendingAction: (() => Promise<unknown>) | null = null;
  busy = false;
  contract?: { name: string; version: number };

  constructor(
    readonly options: OpenRoomOptions,
    private readonly stores: Stores,
  ) {
    // Same identity on reload: the seed is kept next to the key (sessionStorage, or localStorage if remembered).
    this.roomId = deriveRoom(options.secret).roomId;
    const existing = loadRecord(stores, this.roomId);
    this.remembered = existing?.remembered ?? false;
    this.record = existing?.record ?? { v: 1, key: options.key, seed: b64u(newIdentity().seed), savedAt: Date.now() };
    this.record = { ...this.record, key: options.key, savedAt: Date.now() };
    saveRecord(stores, this.roomId, this.record, this.remembered);
    setCurrent(stores, this.roomId);
    this.session = new RoomSession(location.origin, options.secret, identityFromSeed(fromB64u(this.record.seed)));
    this.live = new Live(
      this.session,
      {
        onEvents: (events, via) => this.onEvents(events, via),
        onPresence: (list) => {
          this.presence = new Map(list.map((p) => [p.sender, p]));
          this.render();
        },
        onState: () => this.render(),
      },
      { sender: () => (this.session.joined ? this.session.identity.id : undefined) },
    );
    this.debug.live = this.live.stats;
    window.__lincor = this.debug;
  }

  /* ---------- lifecycle ---------- */

  async start() {
    $("home").hidden = true;
    $("room").hidden = false;
    input().value = this.options.firstMessage ?? "";
    this.setMode("message");
    this.setView("chat");
    this.setSide("tasks");
    this.setReply(undefined);
    this.setFile(undefined);
    this.hideJoin();
    this.autosize();
    this.renderNow();
    this.tick = setInterval(() => this.render(), 30_000);

    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        await this.session.sync();
        this.loaded = true;
        this.loadError = "";
        break;
      } catch (e) {
        this.loadError = e instanceof ApiError ? errorText(e) : "Can't reach lincor right now. Retrying…";
        this.renderNow();
        await new Promise((r) => setTimeout(r, backoffDelay(attempt, 1000, 20_000)));
      }
    }
    if (this.stopped) return;
    this.forceBottom = true;
    this.renderNow();
    this.live.start();
    if (this.options.firstMessage) {
      if (this.session.joined) void this.send();
      else this.askJoin(() => this.send(), "Before your first message, tell the room who you are");
    }
  }

  stop() {
    this.stopped = true;
    this.live.stop();
    clearInterval(this.tick);
    clearTimeout(this.presenceTimer);
    for (const id of ["menuDialog", "contractDialog"]) {
      const d = document.getElementById(id) as HTMLDialogElement | null;
      if (d?.open) d.close();
    }
  }

  /* ---------- live ---------- */

  private onEvents(events: RoomEvent[], via: EventSource) {
    if (this.stopped) return;
    this.debug.eventsVia[via] += events.length;
    const others = events.filter((e) => e.sender !== this.session.identity.id);
    const loud = others.filter((e) => e.type === "message" || e.type === "file" || e.type === "task.create");
    if (document.hidden && loud.length) this.unread += loud.length;
    const last = others.at(-1);
    const line = last ? announcementFor({ state: this.session.state }, last) : null;
    if (line) announce(line);
    // Someone posted, so their presence changed; the socket pushes presence itself, polling has to ask.
    if (via !== "ws" && others.length) this.refreshPresenceSoon();
    this.render();
  }

  private presenceTimer?: ReturnType<typeof setTimeout>;
  private refreshPresenceSoon() {
    clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => void this.live.refreshPresence(), 400);
  }

  /* ---------- rendering ---------- */

  render() {
    if (this.renderQueued || this.stopped) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.stopped) this.renderNow();
    });
  }

  private context(): RenderContext {
    const me = this.session.identity.id;
    const profile = this.session.me?.profile;
    const myHandles = this.session.joined ? handlesFor(me, profile).filter((h) => !BROADCAST_HANDLES.includes(h)) : [];
    return { state: this.session.state, me, myHandles, presence: this.presence, now: Date.now() };
  }

  renderNow() {
    const ctx = this.context();
    const state = this.session.state;
    const title = roomTitle(state);
    $("roomName").textContent = title;
    $("roomName").title = title;
    document.title = `${this.unread ? `(${this.unread}) ` : ""}${title} – Agents secure chat`;
    if (state.meta.name !== this.record.name && state.meta.name !== undefined) {
      this.record = { ...this.record, name: state.meta.name };
      saveRecord(this.stores, this.roomId, this.record, this.remembered);
    }

    const lock = $("lock");
    const rejected = this.session.rejected;
    lock.title =
      "Messages, files and names are encrypted and decrypted in this browser." +
      (rejected ? ` ${rejected} ${rejected === 1 ? "event" : "events"} could not be verified and ${rejected === 1 ? "was" : "were"} ignored.` : "");
    lock.setAttribute("aria-label", lock.title);
    if (rejected) lock.dataset.rejected = String(rejected);
    else delete lock.dataset.rejected;

    $("conn").textContent = this.loadError ? "Offline" : this.live.status === "offline" ? "Reconnecting…" : "";

    const people = [...state.participants.values()].filter((p) => p.profile && !p.left);
    $("peopleCount").textContent = String(people.length);
    replaceHtml($("peopleList"), peopleHtml(ctx));

    this.renderFeed(ctx);
    this.renderSide(ctx);
    this.renderDeleted();

    const transport = this.live.transport === "socket" ? "ws" : this.live.transport === "poll" ? "poll" : "none";
    this.debug.transport = transport;
    this.debug.lastSeq = this.session.state.lastSeq;
    this.debug.rejected = this.session.rejected;
    window.__lincorTransport = transport;
  }

  private renderFeed(ctx: RenderContext) {
    const list = $("feedList");
    const scroller = $("feedScroll");
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    let html: string;
    if (!this.loaded) {
      html = `<div class="empty"><p>${escapeHtml(this.loadError || "Decrypting the room in this browser…")}</p></div>`;
    } else {
      const items = feedItems(ctx.state, ctx.me, ctx.now);
      html = hasConversation(items) ? feedHtml(ctx, items) : emptyFeedHtml;
    }
    list.classList.toggle("is-empty", !this.loaded || html === emptyFeedHtml);
    replaceHtml(list, html);
    if (nearBottom || this.forceBottom) {
      scroller.scrollTop = scroller.scrollHeight;
      if (this.loaded) this.forceBottom = false;
    }
  }

  private renderSide(ctx: RenderContext) {
    document.querySelectorAll<HTMLElement>(".tabs [data-side]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.side === this.sideTab)));
    const counts: Record<SideTab, number> = { tasks: ctx.state.tasks.size, contracts: ctx.state.artifacts.size, files: ctx.state.files().length };
    document.querySelectorAll<HTMLElement>(".tabs [data-count]").forEach((c) => (c.textContent = String(counts[c.dataset.count as SideTab] ?? "")));
    $("sidePath").textContent = `~/room/${this.sideTab}`;
    const html = this.sideTab === "tasks" ? tasksHtml(ctx) : this.sideTab === "contracts" ? contractsHtml(ctx) : filesHtml(ctx);
    replaceHtml($("sideList"), html);
    $("sideList").setAttribute("aria-label", this.sideTab[0].toUpperCase() + this.sideTab.slice(1));
    if (this.contract && ($("contractDialog") as HTMLDialogElement).open) this.renderContract();
  }

  private renderDeleted() {
    const deleted = this.session.deleted;
    $("deletedBanner").hidden = !deleted;
    if (deleted) {
      $("purgeText").textContent = `Anyone with the link can restore it until ${untilLabel(deleted.purge_at)}. After that it is erased for good.`;
    }
    const disabled = !!deleted;
    input().disabled = disabled;
    $<HTMLButtonElement>("sendBtn").disabled = disabled || this.busy;
    $<HTMLButtonElement>("attachBtn").disabled = disabled;
  }

  /* ---------- view state ---------- */

  setView(view: View) {
    this.view = view;
    $("room").dataset.view = view;
    document.querySelectorAll<HTMLElement>(".nav [data-view]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
    if (view === "tasks" || view === "contracts" || view === "files") this.setSide(view);
    if (view === "chat") {
      const sc = $("feedScroll");
      sc.scrollTop = sc.scrollHeight;
    }
  }

  setSide(tab: SideTab) {
    this.sideTab = tab;
    this.renderSide(this.context());
  }

  setMode(mode: "message" | "task") {
    this.mode = mode;
    document.querySelectorAll<HTMLElement>(".segment [data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    input().placeholder =
      mode === "task"
        ? narrow()
          ? "Describe a task, @role to assign"
          : "Describe a task, @backend to assign it"
        : narrow()
          ? "Message the room"
          : "Message the room, @backend to address someone";
    input().setAttribute("aria-label", mode === "task" ? "New task" : "Message");
    $("sendBtn").textContent = mode === "task" ? "Create task" : "Send";
  }

  setReply(cid: string | undefined) {
    this.replyTo = cid;
    $("replyBar").hidden = !cid;
    if (cid) {
      const ev = this.session.state.event(cid);
      $("replyName").textContent = ev ? nameOf({ state: this.session.state }, ev.sender) : "a message";
      if (this.mode === "task") this.setMode("message");
      input().focus();
    }
  }

  setFile(file: File | undefined) {
    this.pendingFile = file;
    $("attachBar").hidden = !file;
    $("attachName").textContent = file ? `${file.name} · ${formatBytes(file.size)}` : "";
  }

  autosize() {
    const ta = input();
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.3) + "px";
  }

  /* ---------- joining ---------- */

  askJoin(action: () => Promise<unknown>, title = "Before you post, tell the room who you are") {
    this.pendingAction = action;
    $("joinTitle").textContent = title;
    $("joinForm").hidden = false;
    if (this.view !== "chat") this.setView("chat");
    const name = $<HTMLInputElement>("joinName");
    requestAnimationFrame(() => name.focus());
  }

  hideJoin() {
    this.pendingAction = null;
    $("joinForm").hidden = true;
    $<HTMLInputElement>("joinName").removeAttribute("aria-invalid");
  }

  async join() {
    if (this.busy) return;
    const nameInput = $<HTMLInputElement>("joinName");
    const name = nameInput.value.trim();
    const role = $<HTMLInputElement>("joinRole").value.trim() || "person";
    if (!name) {
      nameInput.setAttribute("aria-invalid", "true");
      nameInput.focus();
      toast("Enter the name the room should see", "error");
      return;
    }
    const action = this.pendingAction;
    this.setBusy(true);
    try {
      await this.session.join({ name, role, client: "browser", kind: "human" });
      this.hideJoin();
      this.live.restart();
      this.refreshPresenceSoon();
      announce(`Joined as ${name}`);
    } catch (e) {
      toast(errorText(e), "error");
      return;
    } finally {
      this.setBusy(false);
      this.render();
    }
    if (action) await action();
  }

  /** Runs a write once this browser has joined the room, asking for a name first if needed. */
  whenJoined(action: () => Promise<unknown>, title?: string) {
    if (this.session.deleted) return toast("This room is deleted. Restore it first.", "error");
    if (this.session.joined) return void this.guard(action);
    this.askJoin(() => this.guard(action), title);
  }

  private async guard(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      this.render();
    }
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    $("composer").classList.toggle("is-busy", busy);
    $<HTMLButtonElement>("sendBtn").disabled = busy || !!this.session.deleted;
    $<HTMLButtonElement>("joinGo").disabled = busy;
  }

  /* ---------- posting ---------- */

  async send(): Promise<void> {
    if (this.busy) return;
    const raw = input().value.replace(/^\s*\n/, "").trimEnd();
    const file = this.pendingFile;
    if (!raw.trim() && !file) return;
    if (this.session.deleted) return toast("This room is deleted. Restore it to post again.", "error");
    if (!this.session.joined) return this.askJoin(() => this.send());
    if (file && file.size > MAX_FILE_BYTES) return toast(`Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB.`, "error");
    this.setBusy(true);
    try {
      const bytes = file ? new Uint8Array(await file.arrayBuffer()) : undefined;
      const mime = file?.type || "application/octet-stream";
      if (this.mode === "task") {
        const task = parseTaskInput(raw);
        let refs: string[] | undefined;
        if (file && bytes) refs = [(await this.session.shareFile(bytes, file.name, mime)).cid];
        if (task) await this.session.createTask({ ...task, ...(refs ? { refs } : {}) });
      } else if (file && bytes) {
        await this.session.shareFile(bytes, file.name, mime, { ...(raw.trim() ? { text: raw } : {}), ...(this.replyTo ? { replyTo: this.replyTo } : {}) });
      } else {
        await this.session.say(raw, this.replyTo ? { replyTo: this.replyTo } : {});
      }
      input().value = "";
      this.setReply(undefined);
      this.setFile(undefined);
      this.autosize();
      this.forceBottom = true;
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      this.setBusy(false);
      this.renderNow();
    }
  }

  stageFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast(`${file.name} is ${formatBytes(file.size)}. Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB.`, "error");
      return;
    }
    this.setFile(file);
    input().focus();
  }

  updateTask(id: string, status: TaskStatus) {
    const task = this.session.state.tasks.get(id);
    this.whenJoined(async () => {
      await this.session.updateTask(id, status);
      announce(`${task?.title ?? "Task"} moved to ${STATUS_LABEL[status]}`);
    }, "To change a task, first tell the room who you are");
  }

  /* ---------- files and contracts ---------- */

  async download(cid: string, button?: HTMLButtonElement | null) {
    const ev = this.session.state.event(cid);
    if (!ev || ev.type !== "file") return;
    const label = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = "Decrypting…";
    }
    try {
      const bytes = await this.session.downloadFile(ev.body);
      saveBytes(bytes, safeFileName(ev.body.name), ev.body.mime);
      announce(`Saved ${ev.body.name}`);
    } catch (e) {
      toast(e instanceof ApiError && e.status === 404 ? "This file is no longer on the server." : errorText(e), "error");
    } finally {
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = label ?? "Download";
      }
    }
  }

  openContract(name: string, version?: number) {
    const artifact = this.session.state.artifacts.get(name);
    if (!artifact) return;
    this.contract = { name, version: version ?? artifact.versions.length };
    this.showContractEditor(false);
    this.renderContract();
    const d = $<HTMLDialogElement>("contractDialog");
    if (!d.open) d.showModal();
  }

  renderContract() {
    if (!this.contract) return;
    const artifact = this.session.state.artifacts.get(this.contract.name);
    if (!artifact) return;
    const v = artifact.versions[this.contract.version - 1] ?? artifact.versions.at(-1)!;
    const latest = artifact.versions.length;
    $("contractTitle").textContent = artifact.name;
    $("contractVersions").innerHTML = artifact.versions
      .slice()
      .reverse()
      .map(
        (x) =>
          `<button type="button" data-version="${x.version}" aria-pressed="${x.version === v.version}" title="${escapeHtml(`${nameOf({ state: this.session.state }, x.by)}, ${whenLabel(x.ts)}${x.note ? ` · ${x.note}` : ""}`)}">version ${x.version}${x.version === latest ? " (latest)" : ""}</button>`,
      )
      .join("");
    const who = nameOf({ state: this.session.state }, v.by);
    $("contractMeta").textContent = `Version ${v.version} of ${latest} by ${who}, ${whenLabel(v.ts)}${v.note ? `. ${v.note}` : ""}`;
    const content = $("contractContent");
    if (v.content !== undefined) content.textContent = v.content;
    else if (v.file) content.textContent = `This version is a file (${v.file.name}, ${formatBytes(v.file.size)}). Download it to open it.`;
    else content.textContent = "This version is empty.";
    $("contractDownload").textContent = `Download version ${v.version}`;
  }

  /** New contract (no name yet) or a new version of the open one (PRD FR-7.2: anyone may pin a version). */
  newContract() {
    this.contract = { name: "", version: 0 };
    $("contractTitle").textContent = "New contract";
    $<HTMLInputElement>("contractName").value = "";
    $<HTMLTextAreaElement>("contractText").value = "";
    $<HTMLInputElement>("contractNote").value = "";
    this.showContractEditor(true, true);
    const d = $<HTMLDialogElement>("contractDialog");
    if (!d.open) d.showModal();
    $<HTMLInputElement>("contractName").focus();
  }

  editContract() {
    if (!this.contract) return;
    const v = this.session.state.artifacts.get(this.contract.name)?.versions[this.contract.version - 1];
    $<HTMLTextAreaElement>("contractText").value = v?.content ?? "";
    $<HTMLInputElement>("contractNote").value = "";
    this.showContractEditor(true, false);
    $<HTMLTextAreaElement>("contractText").focus();
  }

  showContractEditor(editing: boolean, naming = false) {
    $("contractEdit").hidden = !editing;
    $("contractActions").hidden = editing;
    $("contractContent").hidden = editing;
    $("contractVersions").hidden = editing && naming;
    $("contractMeta").hidden = editing && naming;
    $("contractName").hidden = !naming;
    $("contractNameLabel").hidden = !naming;
    const next = naming ? 1 : (this.session.state.artifacts.get(this.contract?.name ?? "")?.versions.length ?? 0) + 1;
    $("contractSave").textContent = `Pin version ${next}`;
  }

  saveContract() {
    if (!this.contract) return;
    const naming = !this.contract.name;
    const name = naming ? $<HTMLInputElement>("contractName").value.trim() : this.contract.name;
    const text = $<HTMLTextAreaElement>("contractText").value;
    const note = $<HTMLInputElement>("contractNote").value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) return toast("Name the contract with letters, digits, '.', '_' or '-', like api-contract.", "error");
    if (naming && this.session.state.artifacts.has(name)) return toast(`"${name}" already exists. Open it and pin a new version instead.`, "error");
    if (!text.trim()) return toast("The contract is empty.", "error");
    this.whenJoined(async () => {
      await this.session.putArtifact(name, utf8(text), note ? { note } : {});
      const version = this.session.state.artifacts.get(name)?.versions.length ?? 1;
      announce(`Pinned ${name} version ${version}`);
      this.contract = { name, version };
      this.showContractEditor(false);
      this.renderContract();
      const d = $<HTMLDialogElement>("contractDialog");
      if (!d.open) d.showModal();
    }, "To pin a contract, first tell the room who you are");
  }

  async downloadContract() {
    if (!this.contract) return;
    const { name, version } = this.contract;
    try {
      const { content } = await this.session.readArtifact(name, version);
      const v = this.session.state.artifacts.get(name)?.versions[version - 1];
      const fileName = v?.file ? safeFileName(v.file.name.includes(".") ? v.file.name : artifactFileName(name, version)) : artifactFileName(name, version, v?.content);
      saveBytes(content, fileName, v?.file?.mime ?? "text/plain");
      announce(`Saved ${fileName}`);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  /* ---------- settings ---------- */

  openMenu() {
    const state = this.session.state;
    $<HTMLInputElement>("renameInput").value = state.meta.name ?? "";
    this.showTtl(state.meta.ttlDays ?? null);
    $<HTMLInputElement>("rememberToggle").checked = this.remembered;
    $("deleteConfirm").hidden = true;
    $("deleteStart").hidden = false;
    $<HTMLDialogElement>("menuDialog").showModal();
    // The server knows the current TTL even if no room.ttl event was seen; never overwrite the person's choice.
    const select = $<HTMLSelectElement>("ttlSelect");
    select.dataset.dirty = "";
    void this.session.client
      .info()
      .then((info) => info.exists && !select.dataset.dirty && this.showTtl(info.msg_ttl_days ?? null))
      .catch(() => undefined);
  }

  private showTtl(days: number | null) {
    const select = $<HTMLSelectElement>("ttlSelect");
    const value = days ? String(days) : "";
    if (![...select.options].some((o) => o.value === value)) select.add(new Option(`After ${days} days`, value));
    select.value = value;
    $("ttlHint").textContent = `${ttlLabel(days)}. The server deletes messages and files older than this.`;
  }

  rename(name: string) {
    $<HTMLDialogElement>("menuDialog").close();
    this.whenJoined(async () => {
      await this.session.setMeta({ name: name.trim() });
      announce("Room renamed");
    }, "To rename the room, first tell the room who you are");
  }

  setTtl(days: number | null) {
    $<HTMLDialogElement>("menuDialog").close();
    this.whenJoined(async () => {
      await this.session.setTtl(days);
      toast(ttlLabel(days));
    }, "To change message expiry, first tell the room who you are");
  }

  setRemember(remember: boolean) {
    this.remembered = remember;
    saveRecord(this.stores, this.roomId, { ...this.record, savedAt: Date.now() }, remember);
    announce(remember ? "This browser will remember the room" : "The room is kept in this tab only");
  }

  async deleteRoom() {
    try {
      await this.session.remove();
      await this.session.sync();
      if (!this.session.deleted) this.session.deleted = { purge_at: Date.now() + 86_400_000 };
      $<HTMLDialogElement>("menuDialog").close();
      toast("Room deleted. It can be restored for 24 hours.");
      this.live.kick();
    } catch (e) {
      toast(e instanceof ApiError && e.status === 404 ? "Nothing to delete yet: no one has posted in this room." : errorText(e), "error");
    } finally {
      this.render();
    }
  }

  async restoreRoom() {
    try {
      await this.session.restore();
      await this.session.sync();
      this.session.deleted = undefined;
      toast("Room restored");
      this.live.kick();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      this.render();
    }
  }

  copyLink(button?: HTMLElement | null) {
    void copyText(this.session.link, button);
  }

  copyInvite(button?: HTMLElement | null) {
    void copyText(inviteText(this.session.link), button);
  }

  goto(cid: string) {
    const el = $("feedList").querySelector<HTMLElement>(`[data-cid="${CSS.escape(cid)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el.classList.add("is-flash");
    setTimeout(() => el.classList.remove("is-flash"), 1200);
  }

  clearUnread() {
    if (!this.unread) return;
    this.unread = 0;
    this.render();
  }
}

/* ---------- module state and DOM wiring (bound once) ---------- */

let current: RoomController | null = null;

export const currentRoom = () => current;

export function closeRoom() {
  current?.stop();
  current = null;
}

export function openRoom(options: OpenRoomOptions): RoomController {
  closeRoom();
  current = new RoomController(options, options.stores);
  void current.start();
  return current;
}

function onTabKeys(list: HTMLElement, selector: string) {
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    const tabs = [...list.querySelectorAll<HTMLElement>(selector)];
    const at = tabs.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    tabs[next].click();
  });
}

export function initRoom() {
  const on = <K extends keyof HTMLElementEventMap>(id: string, type: K, fn: (e: HTMLElementEventMap[K], room: RoomController) => void) =>
    $(id).addEventListener(type, (e) => {
      if (current) fn(e as HTMLElementEventMap[K], current);
    });

  on("feedList", "click", (e, room) => {
    const t = e.target as HTMLElement;
    const reply = t.closest<HTMLElement>("[data-reply]");
    if (reply) return room.setReply(reply.dataset.reply);
    const dl = t.closest<HTMLButtonElement>("[data-download]");
    if (dl) return void room.download(dl.dataset.download!, dl);
    const art = t.closest<HTMLElement>("[data-artifact]");
    if (art) return room.openContract(art.dataset.artifact!, Number(art.dataset.version) || undefined);
    const go = t.closest<HTMLElement>("[data-goto]");
    if (go) return room.goto(go.dataset.goto!);
    const invite = t.closest<HTMLElement>("[data-copy-invite]");
    if (invite) return room.copyInvite(invite);
  });
  on("sideList", "click", (e, room) => {
    const t = e.target as HTMLElement;
    const status = t.closest<HTMLElement>("[data-task-status]");
    if (status) return room.updateTask(status.dataset.taskId!, status.dataset.taskStatus as TaskStatus);
    const dl = t.closest<HTMLButtonElement>("[data-download]");
    if (dl) return void room.download(dl.dataset.download!, dl);
    if (t.closest("[data-new-contract]")) return room.newContract();
    const art = t.closest<HTMLElement>("[data-artifact]");
    if (art) return room.openContract(art.dataset.artifact!);
  });

  document.querySelectorAll<HTMLElement>(".nav [data-view]").forEach((b) => b.addEventListener("click", () => current?.setView(b.dataset.view as View)));
  document.querySelectorAll<HTMLElement>(".tabs [data-side]").forEach((b) => b.addEventListener("click", () => current?.setSide(b.dataset.side as SideTab)));
  document.querySelectorAll<HTMLElement>(".segment [data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      current?.setMode(b.dataset.mode as "message" | "task");
      input().focus();
    }),
  );
  onTabKeys(document.querySelector<HTMLElement>(".nav")!, "[data-view]");
  onTabKeys(document.querySelector<HTMLElement>(".tabs")!, "[data-side]");

  on("composer", "submit", (e, room) => {
    e.preventDefault();
    void room.send();
  });
  on("composerInput", "keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $<HTMLFormElement>("composer").requestSubmit();
    } else if (e.key === "Escape" && current?.replyTo) current.setReply(undefined);
  });
  on("composerInput", "input", (_e, room) => room.autosize());
  on("attachBtn", "click", () => $<HTMLInputElement>("fileInput").click());
  on("fileInput", "change", (_e, room) => {
    const fi = $<HTMLInputElement>("fileInput");
    room.stageFile(fi.files?.[0]);
    fi.value = "";
  });
  on("attachCancel", "click", (_e, room) => room.setFile(undefined));
  on("replyCancel", "click", (_e, room) => {
    room.setReply(undefined);
    input().focus();
  });
  on("joinGo", "click", (_e, room) => void room.join());
  on("joinCancel", "click", (_e, room) => {
    room.hideJoin();
    input().focus();
  });
  for (const id of ["joinName", "joinRole"]) {
    on(id, "keydown", (e, room) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void room.join();
      } else if (e.key === "Escape") {
        e.preventDefault();
        room.hideJoin();
        input().focus();
      }
    });
  }

  on("copyLinkRoom", "click", (e, room) => room.copyLink(e.currentTarget as HTMLElement));
  on("inviteRoom", "click", (e, room) => room.copyInvite(e.currentTarget as HTMLElement));
  on("menuBtn", "click", (_e, room) => room.openMenu());
  on("menuCopyLink", "click", (e, room) => room.copyLink(e.currentTarget as HTMLElement));
  on("menuInvite", "click", (e, room) => room.copyInvite(e.currentTarget as HTMLElement));
  on("renameForm", "submit", (e, room) => {
    e.preventDefault();
    room.rename($<HTMLInputElement>("renameInput").value);
  });
  on("ttlForm", "submit", (e, room) => {
    e.preventDefault();
    const v = $<HTMLSelectElement>("ttlSelect").value;
    room.setTtl(v ? Number(v) : null);
  });
  on("ttlSelect", "change", () => {
    $<HTMLSelectElement>("ttlSelect").dataset.dirty = "1";
  });
  on("rememberToggle", "change", (_e, room) => room.setRemember($<HTMLInputElement>("rememberToggle").checked));
  on("deleteStart", "click", () => {
    $("deleteConfirm").hidden = false;
    $("deleteStart").hidden = true;
    $("deleteGo").focus();
  });
  on("deleteCancel", "click", () => {
    $("deleteConfirm").hidden = true;
    $("deleteStart").hidden = false;
    $("deleteStart").focus();
  });
  on("deleteGo", "click", (_e, room) => void room.deleteRoom());
  on("restoreBtn", "click", (_e, room) => void room.restoreRoom());
  on("contractVersions", "click", (e, room) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-version]");
    if (b && room.contract) {
      room.contract.version = Number(b.dataset.version);
      room.renderContract();
    }
  });
  on("contractDownload", "click", (_e, room) => void room.downloadContract());
  on("contractEditBtn", "click", (_e, room) => room.editContract());
  on("contractEditCancel", "click", (_e, room) => {
    if (room.contract?.name) {
      room.showContractEditor(false);
      room.renderContract();
    } else $<HTMLDialogElement>("contractDialog").close();
  });
  on("contractEdit", "submit", (e, room) => {
    e.preventDefault();
    room.saveContract();
  });

  // Keep the newest message in view when the feed gets shorter (rotation, keyboard, the name prompt opening),
  // as long as the reader was already at the bottom.
  const scroller = $("feedScroll");
  let stick = true;
  scroller.addEventListener("scroll", () => {
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  });
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (stick) scroller.scrollTop = scroller.scrollHeight;
    }).observe(scroller);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) current?.clearUnread();
  });
  window.addEventListener("resize", () => current?.setMode(current.mode));
}
