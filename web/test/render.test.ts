import { RoomState, shortId, type RoomEvent } from "@lincor/core";
import { describe, expect, it } from "vitest";
import { aboutHtml, feedHtml, filesHtml, peopleHtml, tasksHtml, type RenderContext } from "../src/render";
import { feedItems } from "../src/view";

let seq = 0;
const ev = (sender: string, type: RoomEvent["type"], body: unknown, ts = Date.now()): RoomEvent =>
  ({ seq: ++seq, ts, cid: `c${seq}`.padEnd(22, "0"), sender, pub: "", clientTs: ts, type, body }) as RoomEvent;

const EVIL = `<img src=x onerror=alert(1)>"'`;
const A = "AAAAAAAAAAAAAAAAAAAAAA";
const M = "MMMMMMMMMMMMMMMMMMMMMM";

function hostileRoom(): RenderContext {
  seq = 0;
  const state = new RoomState();
  state.apply(ev(A, "join", { profile: { name: EVIL, role: EVIL, client: EVIL, kind: "agent", status: EVIL, owner: EVIL } }));
  state.apply(ev(A, "message", { text: `${EVIL} @me`, mentions: ["me"] }));
  state.apply(ev(A, "task.create", { title: EVIL, description: EVIL, assignee: EVIL, acceptance: [EVIL] }));
  state.apply(ev(A, "file", { blob: "b", name: EVIL, mime: "text/html", size: 10, sha256: "", key: "", np: "", cs: 65536, text: EVIL }));
  state.apply(ev(A, "artifact.put", { name: EVIL, content: EVIL, note: EVIL }));
  state.apply(ev(A, "room.meta", { name: EVIL, description: `${EVIL}\nsecond line` }));
  state.apply(ev(M, "join", { profile: { name: "Me", role: "person", client: "browser", kind: "human" } }));
  return { state, me: M, myHandles: ["me"], presence: new Map(), now: Date.now() };
}

const noInjectedMarkup = (html: string) => {
  expect(html).not.toContain("<img");
  // Every attribute value is double-quoted and contains no raw quote characters.
  for (const tag of html.match(/<[a-z][^>]*>/g) ?? []) {
    const rest = tag.replace(/^<[a-z0-9]+/, "").replace(/\/?>$/, "");
    const leftover = rest.replace(/\s[a-zA-Z-]+="[^"]*"/g, "").replace(/\s[a-zA-Z-]+(?=\s|$)/g, "").trim();
    expect(leftover, tag).toBe("");
  }
};

describe("pane HTML is safe with hostile room content", () => {
  it("people", () => {
    const html = peopleHtml(hostileRoom());
    noInjectedMarkup(html);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("(you)");
  });
  it("feed", () => {
    const ctx = hostileRoom();
    const html = feedHtml(ctx, feedItems(ctx.state, ctx.me, ctx.now));
    noInjectedMarkup(html);
    expect(html).toContain('<span class="mention mention--me">@me</span>');
    expect(html).toContain('class="msg msg--for-me"');
  });
  it("about", () => {
    const html = aboutHtml(hostileRoom());
    noInjectedMarkup(html);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("second line");
    expect(html).toMatch(/by &lt;img src=x onerror=alert\(1\)&gt;/);
    const empty = aboutHtml({ ...hostileRoom(), state: new RoomState() });
    expect(empty).toContain("No About yet");
    expect(empty).toContain("data-about-edit");
  });
  it("tasks and files", () => {
    const ctx = hostileRoom();
    noInjectedMarkup(tasksHtml(ctx));
    noInjectedMarkup(filesHtml(ctx));
    expect(tasksHtml(ctx)).toContain('data-task-status="accepted"');
  });
});

describe("duplicate names", () => {
  it("shows fingerprints when two participants share a name", () => {
    seq = 0;
    const state = new RoomState();
    state.apply(ev(A, "join", { profile: { name: "backend", role: "backend", client: "codex", kind: "agent" } }));
    state.apply(ev(M, "join", { profile: { name: "backend", role: "backend", client: "codex", kind: "agent" } }));
    const html = peopleHtml({ state, myHandles: [], presence: new Map(), now: Date.now() });
    expect(html).toContain(`backend · ${shortId(A)}`);
    expect(html).toContain(`backend · ${shortId(M)}`);
    expect(shortId(A)).not.toBe(shortId(M));
  });
});
