import { RoomState, type RoomEvent } from "@lincor/core";
import { describe, expect, it } from "vitest";
import {
  activityText,
  ago,
  artifactFileName,
  backoffDelay,
  dayLabel,
  escapeHtml,
  feedItems,
  firstLine,
  formatBytes,
  hasConversation,
  initialOf,
  parseTaskInput,
  presenceView,
  renderText,
  roomTitle,
  safeFileName,
  taskActions,
  untilLabel,
} from "../src/view";

describe("escapeHtml", () => {
  it("escapes markup and quotes", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("renderText", () => {
  it("highlights mentions and marks the viewer's own", () => {
    const html = renderText("@backend and @Kamola, ping @all.", { isMine: (h) => h === "kamola" });
    expect(html).toBe(
      '<p><span class="mention">@backend</span> and <span class="mention mention--me">@Kamola</span>, ping <span class="mention">@all</span>.</p>',
    );
  });

  it("does not treat e-mail addresses as mentions", () => {
    expect(renderText("mail ali@example.com")).toBe("<p>mail ali@example.com</p>");
  });

  it("trims trailing dots from a mention like the protocol does", () => {
    expect(renderText("thanks @unity...")).toBe('<p>thanks <span class="mention">@unity</span>...</p>');
  });

  it("escapes HTML everywhere, including around mentions", () => {
    const html = renderText(`<script>alert(1)</script> <img src=x onerror=alert(1)> @x<b>`);
    expect(html).not.toMatch(/<script|<img|<b>/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('<span class="mention">@x</span>&lt;b&gt;');
  });

  it("cannot be broken out of with a crafted mention or attribute", () => {
    const html = renderText(`@a"onmouseover="alert(1) [x](https://e.com/"onclick="alert(1))`);
    expect(html).not.toMatch(/ onmouseover=| onclick=/);
    // Every attribute in the output is one we emit, with a double-quoted value that contains no quote.
    for (const tag of html.match(/<[a-z][^>]*>/g) ?? []) {
      const rest = tag.replace(/^<[a-z]+/, "").replace(/>$/, "");
      expect(rest).toMatch(/^(\s(class|href|target|rel)="[^"]*")*$/);
    }
  });

  it("links only http(s) URLs", () => {
    expect(renderText("see https://agents-room.cc/docs.")).toBe(
      '<p>see <a href="https://agents-room.cc/docs" target="_blank" rel="noopener noreferrer nofollow">https://agents-room.cc/docs</a>.</p>',
    );
    expect(renderText("[docs](https://agents-room.cc)")).toContain('<a href="https://agents-room.cc/"');
    for (const bad of ["[x](javascript:alert(1))", "javascript:alert(1)", "[x](data:text/html,hi)", "<javascript:alert(1)>"]) {
      expect(renderText(bad)).not.toContain("<a ");
    }
  });

  it("renders code without mentions or links inside", () => {
    expect(renderText("run `npx agents-room <x>` now")).toBe("<p>run <code>npx agents-room &lt;x&gt;</code> now</p>");
    const block = renderText("before\n```json\n{\"a\": \"@b <i>\"}\n```\nafter");
    expect(block).toBe('<p>before</p><pre><code>{&quot;a&quot;: &quot;@b &lt;i&gt;&quot;}</code></pre><p>after</p>');
  });

  it("keeps an unterminated fence as text", () => {
    expect(renderText("```\n<b>")).toBe("<p>```<br>&lt;b&gt;</p>");
  });

  it("renders paragraphs, line breaks and bold", () => {
    expect(renderText("one\ntwo\n\n**three**")).toBe("<p>one<br>two</p><p><strong>three</strong></p>");
    expect(renderText("**<i>x</i>**")).toBe("<p><strong>&lt;i&gt;x&lt;/i&gt;</strong></p>");
  });
});

describe("parseTaskInput", () => {
  it("uses the first line as title, the rest as description, and the first @handle as assignee", () => {
    expect(parseTaskInput("Emit purchase_completed @unity\nFires once per purchase.\n\nSee @frontend")).toEqual({
      title: "Emit purchase_completed",
      description: "Fires once per purchase.\n\nSee @frontend",
      assignee: "@unity",
    });
  });
  it("handles a leading mention and trailing punctuation", () => {
    expect(parseTaskInput("@unity: emit purchase_completed")).toEqual({ title: "emit purchase_completed", assignee: "@unity" });
    expect(parseTaskInput("Ship it, @bobur.")).toEqual({ title: "Ship it", assignee: "@bobur" });
  });
  it("finds an assignee in the description and leaves the title alone", () => {
    expect(parseTaskInput("Validate receipts\nfor @backend")).toEqual({ title: "Validate receipts", description: "for @backend", assignee: "@backend" });
  });
  it("keeps a title that is only a mention and returns null for empty input", () => {
    expect(parseTaskInput("@qa")).toEqual({ title: "@qa", assignee: "@qa" });
    expect(parseTaskInput("  \n ")).toBeNull();
    expect(parseTaskInput("No assignee")).toEqual({ title: "No assignee" });
  });
  it("ignores e-mail addresses", () => {
    expect(parseTaskInput("Mail ali@example.com")).toEqual({ title: "Mail ali@example.com" });
  });
});

describe("labels and formatting", () => {
  it("offers sensible status transitions", () => {
    expect(taskActions("open").map((a) => a.status)).toEqual(["accepted", "in_progress", "done", "rejected"]);
    expect(taskActions("in_progress").map((a) => a.status)).toEqual(["done", "blocked"]);
    expect(taskActions("done")).toEqual([{ status: "open", label: "Reopen" }]);
  });
  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1229)).toBe("1.2 KB");
    expect(formatBytes(312 * 1024)).toBe("312 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
  });
  it("labels days and ages", () => {
    const now = new Date(2026, 9, 17, 15, 0).getTime();
    expect(dayLabel(now - 60_000, now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 16, 9).getTime(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 8, 1).getTime(), now)).toBe("Sep 1");
    expect(dayLabel(new Date(2025, 8, 1).getTime(), now)).toBe("Sep 1, 2025");
    expect(ago(now - 2 * 3600_000, now)).toBe("2h ago");
    expect(ago(now - 10_000, now)).toBe("just now");
    expect(untilLabel(new Date(2026, 9, 18, 14, 9).getTime(), now)).toBe("tomorrow at 14:09");
  });
  it("shows presence like the prototype", () => {
    const now = 1_000_000;
    expect(presenceView({ state: "listening", last_seen: now }, "agent", now).label).toBe("listening");
    expect(presenceView({ state: "listening", last_seen: now }, "human", now).label).toBe("online");
    expect(presenceView({ state: "offline", last_seen: now - 7200_000 }, "agent", now).label).toBe("seen 2h ago");
    expect(presenceView({ state: "online", last_seen: now - 120_000 }, "agent", now).state).toBe("offline");
    expect(presenceView(undefined, "agent", now).label).toBe("offline");
  });
  it("picks initials, first lines and file names", () => {
    expect(initialOf("  ali's agent")).toBe("A");
    expect(initialOf("@@")).toBe("?");
    expect(firstLine("\n  hello\nworld")).toBe("hello");
    expect(firstLine("x".repeat(200), 10)).toBe("xxxxxxxxx…");
    expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFileName("a\u0000b<c>.txt")).toBe("ab_c_.txt");
    expect(safeFileName("...")).toBe("download");
    expect(artifactFileName("event-schema", 2, '{"a":1}')).toBe("event-schema.v2.json");
    expect(artifactFileName("api.yaml", 5)).toBe("api.v5.yaml");
    expect(artifactFileName("notes", 1, "# Title")).toBe("notes.v1.md");
  });
  it("backs off exponentially with a cap", () => {
    expect(backoffDelay(0, 1000, 30_000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 1000, 30_000, () => 1)).toBe(8000);
    expect(backoffDelay(20, 1000, 30_000, () => 1)).toBe(30_000);
    expect(backoffDelay(2, 1000, 30_000, () => 0)).toBe(3000);
  });
});

/* ---------- feed model over a folded RoomState (no crypto needed) ---------- */

let seq = 0;
const ev = (sender: string, type: RoomEvent["type"], body: unknown, ts = Date.now()): RoomEvent =>
  ({ seq: ++seq, ts, cid: `cid${seq}`.padEnd(22, "x"), sender, pub: "", clientTs: ts, type, body }) as RoomEvent;

describe("feedItems", () => {
  it("builds the feed with day separators, activity lines and addressing", () => {
    seq = 0;
    const state = new RoomState();
    const now = new Date(2026, 9, 17, 15, 0).getTime();
    const yesterday = now - 86_400_000;
    const A = "AAAAAAAAAAAAAAAAAAAAAA";
    const B = "BBBBBBBBBBBBBBBBBBBBBB";
    state.apply(ev(A, "join", { profile: { name: "Kamola", role: "team lead", client: "browser", kind: "human" } }, yesterday));
    state.apply(ev(A, "message", { text: "hello", mentions: [] }, yesterday + 1000));
    state.apply(ev(B, "join", { profile: { name: "Bobur's Unity agent", role: "unity", client: "codex", kind: "agent" } }, now - 5000));
    state.apply(ev(B, "status", { text: "Testing" }, now - 4000));
    state.apply(ev(B, "message", { text: "@kamola question", mentions: ["kamola"] }, now - 3000));
    state.apply(ev(A, "task.create", { title: "Emit event", assignee: "@unity" }, now - 2000));
    state.apply(ev(B, "task.update", { task: "cid6".padEnd(22, "x"), status: "done", note: "shipped" }, now - 1000));
    state.apply(ev(A, "room.meta", { name: "Checkout v2" }, now));
    state.apply(ev(A, "message", { text: "@all standup", mentions: ["all"] }, now));

    const items = feedItems(state, A, now);
    expect(items.map((i) => (i.kind === "event" ? `${i.kind}:${i.event.type}` : i.kind === "day" ? `day:${i.label}` : `activity`))).toEqual([
      "day:Yesterday",
      "activity",
      "event:message",
      "day:Today",
      "activity",
      "event:message",
      "event:task.create",
      "activity",
      "activity",
      "event:message",
    ]);
    const forMe = items.filter((i) => i.kind === "event" && i.forMe).map((i) => (i as { key: string }).key);
    expect(forMe).toEqual(["cid5".padEnd(22, "x")]); // the @kamola question; @all is not highlighted
    const texts = items.filter((i) => i.kind === "activity").map((i) => (i as { text: string }).text);
    expect(texts).toEqual([
      "Kamola joined (team lead, Browser)",
      "Bobur's Unity agent joined (unity, Codex)",
      "Bobur's Unity agent moved “Emit event” to Done: shipped",
      "Kamola renamed the room to “Checkout v2”",
    ]);
    expect(hasConversation(items)).toBe(true);
    expect(roomTitle(state)).toBe("Checkout v2");
    expect(activityText(state, ev(B, "room.ttl", { days: null }))).toBe("Bobur's Unity agent turned off message expiry");
    expect(activityText(state, ev(B, "room.meta", { description: "Checkout v2: purchase events.\nContracts in event-schema." }))).toBe(
      "Bobur's Unity agent updated About this room: Checkout v2: purchase events.",
    );
    expect(activityText(state, ev(A, "room.meta", { name: "Checkout v3", description: "Refunds too" }))).toBe(
      "Kamola renamed the room to “Checkout v3” and updated About this room: Refunds too",
    );
  });

  it("is empty for an empty room", () => {
    const state = new RoomState();
    expect(hasConversation(feedItems(state, undefined))).toBe(false);
    expect(roomTitle(state)).toBe("Untitled room");
  });
});
