// Browser end-to-end test for the lincor web app (puppeteer-core + headless Chrome).
//
//   npm run test:e2e -w @lincor/web          builds web/dist, starts the in-memory mock server with --static web/dist
//   LINCOR_E2E_URL=http://127.0.0.1:18080 \
//     node web/test/e2e.mjs                  runs the same scenario against a running lincor server that serves
//                                            web/dist itself; there live updates must arrive over the WebSocket
//
// Environment: CHROME_PATH (default /usr/bin/google-chrome), LINCOR_SHOTS_DIR (screenshots; default
// $TMPDIR/lincor-web-shots), E2E_HEADFUL=1 to watch.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomSession, newIdentity, parseLink, utf8 } from "@lincor/core";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const EXTERNAL = process.env.LINCOR_E2E_URL?.replace(/\/+$/, "");
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const SHOTS = process.env.LINCOR_SHOTS_DIR ?? join(tmpdir(), "lincor-web-shots");
const VIEWPORTS = [
  [360, 640],
  [390, 844],
  [768, 1024],
  [1280, 720],
  [1440, 900],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
let failures = 0;
let stepNo = 0;
const t0 = Date.now();

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

const debugPages = [];
async function dumpDebug() {
  for (const [who, page] of debugPages) {
    try {
      const d = await page.evaluate(() => JSON.stringify({ url: location.href, conn: document.getElementById("conn")?.textContent, lincor: window.__lincor }));
      console.log(`    ${who}: ${d}`);
    } catch {
      // page closed
    }
  }
}

async function step(name, fn) {
  stepNo++;
  const started = Date.now();
  try {
    await fn();
    console.log(`  ok ${stepNo} - ${name} (${Date.now() - started} ms)`);
  } catch (e) {
    failures++;
    console.log(`  not ok ${stepNo} - ${name}\n    ${String(e?.stack ?? e).split("\n").slice(0, 4).join("\n    ")}`);
    await dumpDebug();
    throw e;
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startMock() {
  const port = await freePort();
  const tsx = join(repo, "node_modules", ".bin", "tsx");
  const child = spawn(tsx, ["packages/core/test-support/mock-server.ts", "--port", String(port), "--static", "web/dist"], {
    cwd: repo,
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mock server did not start")), 20_000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("mock lincor server on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`mock server exited with ${code}`)));
  });
  return { origin: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

/* ---------- page helpers ---------- */

const pageErrors = [];
function watch(page, who) {
  page.on("pageerror", (e) => pageErrors.push(`${who}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // Expected noise: the mock server has no WebSocket, and fonts may be unreachable offline.
    if (/WebSocket connection|fonts\.g|Failed to load resource/.test(text)) return;
    pageErrors.push(`${who} console: ${text}`);
  });
}

const visible = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
  }, selector);

async function waitText(page, selector, text, timeout = 15_000) {
  await page.waitForFunction(
    (sel, t) => [...document.querySelectorAll(sel)].some((e) => e.textContent.includes(t)),
    { timeout },
    selector,
    text,
  );
}

/**
 * Clicks a control in a pane that live updates re-render (feed, side list, contract versions, rooms). A locator finds
 * the element again if a render replaces it mid-click; page.click would hit the detached node and throw.
 */
const clickLive = (page, selector) => page.locator(selector).click();

async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/**
 * The room never scrolls as a page (FR-12.2): measured with overflow released, like the prototype's ?check.
 * Home is an ordinary page that may scroll down, but never sideways ({ vertical: false }).
 */
async function noPageScroll(page, label, { vertical = true } = {}) {
  const m = await page.evaluate(() => {
    const d = document.documentElement;
    const b = document.body;
    const prev = [d.style.overflow, b.style.overflow];
    d.style.overflow = "visible";
    b.style.overflow = "visible";
    const r = { sh: d.scrollHeight, sw: d.scrollWidth, ih: innerHeight, iw: innerWidth };
    const clipped = [...document.querySelectorAll(".home__top, .home__body, .home__foot, .linkcard, .room, .bar, .composer, .nav, .feed, .people, .side")]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${el.className}: ${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}`);
    [d.style.overflow, b.style.overflow] = prev;
    return { ...r, clipped };
  });
  if (vertical) assert(m.sh <= m.ih, `${label}: page scrolls vertically (${m.sh} > ${m.ih})`);
  assert(m.sw <= m.iw, `${label}: page scrolls horizontally (${m.sw} > ${m.iw})`);
  assert(m.clipped.length === 0, `${label}: content overflows its container: ${m.clipped.join("; ")}`);
}

async function messageCid(page, text) {
  return page.evaluate((t) => [...document.querySelectorAll(".msg")].find((m) => m.textContent.includes(t))?.dataset.cid, text);
}

async function waitForDownload(dir, name, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const files = await readdir(dir).catch(() => []);
    if (files.includes(name) && !files.some((f) => f.endsWith(".crdownload"))) return join(dir, name);
    await sleep(150);
  }
  throw new Error(`download ${name} did not appear in ${dir}`);
}

async function shiftEnter(page) {
  await page.keyboard.down("Shift");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Shift");
}

/* ---------- scenario ---------- */

async function main() {
  await rm(SHOTS, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "lincor-e2e-"));
  const server = EXTERNAL ? { origin: EXTERNAL, stop: () => undefined } : await startMock();
  const origin = server.origin;
  const mode = EXTERNAL ? "server" : "mock";
  console.log(`lincor web e2e against ${origin} (${mode}); screenshots in ${SHOTS}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !process.env.E2E_HEADFUL,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
  const dlA = join(work, "downloads-a");
  const dlB = join(work, "downloads-b");
  await mkdir(dlA);
  await mkdir(dlB);

  try {
    const ctxA = await browser.createBrowserContext({ downloadBehavior: { policy: "allow", downloadPath: dlA } });
    const ctxB = await browser.createBrowserContext({ downloadBehavior: { policy: "allow", downloadPath: dlB } });
    for (const ctx of [ctxA, ctxB]) await ctx.overridePermissions(origin, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);

    const a = await ctxA.newPage();
    watch(a, "A");
    debugPages.push(["A", a]);
    await a.setViewport({ width: 1280, height: 720 });
    const roomRequests = [];
    a.on("request", (r) => {
      if (r.url().includes("/api/v1/rooms/")) roomRequests.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });

    let link = "";
    let key = "";

    await step("index.html carries the agent instructions and a noscript note for fetchers without JavaScript", async () => {
      // Ask like a browser: the server answers non-browser clients with markdown instructions instead.
      const browser = { Accept: "text/html", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0 Safari/537.36" };
      const html = await (await fetch(`${origin}/r`, { headers: browser })).text();
      assert(/You are an AI agent/.test(html), "agent instructions present");
      if (process.env.LINCOR_E2E_URL) {
        // The real server writes its configured CLI command into the static block.
        const cli = (await (await fetch(`${origin}/api/v1/info`)).json()).cli_command;
        const escaped = cli.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        assert(new RegExp(`<span id="agentCli">${escaped}</span> join '`).test(html), `exact join command present (${cli})`);
      } else {
        assert(/<span id="agentCli">npx -y agents-room@\d+\.\d+\.\d+<\/span> join '/.test(html), "exact join command present");
      }
      assert(/including the part after #/i.test(html), "says to include the part after #");
      assert(/<noscript>/.test(html), "noscript note present");
      assert(/integrity="sha384-/.test(html) && /app\.js\?v=[0-9a-f]{12}/.test(html), "hashed, SRI-protected assets");
    });

    await step("A opens home: JavaScript hides the agent block, connect commands come from /api/v1/info", async () => {
      await a.goto(`${origin}/`, { waitUntil: "networkidle0" });
      assert(await visible(a, "#home"), "home visible");
      assert(!(await visible(a, "#agentNote")), "agent note hidden");
      assert(!(await visible(a, "#room")), "room hidden");
      const info = await (await fetch(`${origin}/api/v1/info`)).json();
      await waitText(a, '#connectDialog [data-cmd="claude"]', `${info.cli_command} install claude-code`);
      await waitText(a, '#connectDialog [data-cmd="codex"]', `${info.cli_command} install codex`);
      assert(!(await a.$("#relay")), "no server status in the home header");
      await a.keyboard.press("Tab");
      await a.keyboard.press("Tab");
      const focus = await a.evaluate(() => {
        const el = document.activeElement;
        return { id: el?.id, outline: getComputedStyle(el).outlineStyle };
      });
      assert(focus.outline === "solid", `keyboard focus is visible (${JSON.stringify(focus)})`);
    });

    await step("Home shows a fresh room link right away, made locally with no network request", async () => {
      const shown = (await a.$eval("#linkText", (e) => e.textContent)).trim();
      assert(shown.startsWith(`${origin}/r#`), `link shown: ${shown}`);
      key = shown.slice(shown.indexOf("#") + 1);
      assert(key.length >= 48 && key.length <= 52, `key length ${key.length}`);
      parseLink(shown); // valid checksum
      const parts = await a.evaluate(() => ({
        key: document.querySelector("#linkText .url__key")?.textContent,
        hash: document.querySelector("#linkText .url__hash")?.textContent,
        prompt: document.getElementById("promptLink")?.textContent,
      }));
      assert(parts.key === key && parts.hash === "#" && parts.prompt === shown, `link parts and agent prompt: ${JSON.stringify(parts)}`);
      assert(roomRequests.length === 0, `no room requests yet: ${roomRequests.join(", ")}`);
      await waitText(a, ".warning", "can recover it");
      await a.click("#newLink");
      const other = (await a.$eval("#linkText", (e) => e.textContent)).trim();
      assert(other !== shown && other.startsWith(`${origin}/r#`), "New link makes another link");
      key = other.slice(other.indexOf("#") + 1);
      assert(roomRequests.length === 0, "still no room requests");
      await shot(a, "flow-01-home-1280x720");
    });

    await step("Copy link, Copy invite and Copy prompt confirm on the button and put the right text on the clipboard", async () => {
      await a.click("#copyLinkHome");
      await waitText(a, "#copyLinkHome", "Link copied");
      link = await a.evaluate(() => navigator.clipboard.readText()).catch(() => "");
      if (!link) link = `${origin}/r#${key}`;
      assert(link === `${origin}/r#${key}`, `copied link ${link}`);
      await a.click("#copyInviteHome");
      await waitText(a, "#copyInviteHome", "Invite copied");
      const invite = await a.evaluate(() => navigator.clipboard.readText()).catch(() => "");
      const agentPrompt = [
        `Join this Agents secure chat room and connect this session to it: ${link}`,
        "1. Join with the full link, from this project's folder.",
        "2. Read the room's About, then tell me who is there and what is addressed to us.",
        "3. Keep listening in the background and handle what is addressed to you as it arrives. Follow the room's rules: ask me before changing code or sharing files.",
      ].join("\n");
      if (invite) assert(invite === `Paste this whole message into Claude Code or Codex:\n\n${agentPrompt}`, `invite text: ${invite}`);
      await a.click("#copyPromptHome");
      await waitText(a, "#copyPromptHome", "Prompt copied");
      const prompt = await a.evaluate(() => navigator.clipboard.readText()).catch(() => "");
      if (prompt) assert(prompt === agentPrompt, `agent prompt: ${prompt}`);
      // What the panel shows is what gets copied.
      const shown = await a.$eval(".term", (t) => t.innerText);
      for (const line of agentPrompt.split("\n").slice(1)) assert(shown.includes(line), `prompt panel shows: ${line}`);
    });

    await step("Open room, write the first message: URL loses the fragment, nothing is sent before the name", async () => {
      await a.click("#openRoom");
      await a.waitForSelector("#room:not([hidden])");
      await a.type("#composerInput", "Hello team, the checkout build is ready for review.");
      await a.keyboard.press("Enter");
      await a.waitForSelector("#joinForm:not([hidden])");
      const loc = await a.evaluate(() => ({ path: location.pathname, hash: location.hash, href: location.href }));
      assert(loc.path === "/r" && loc.hash === "" && !loc.href.includes(key), `URL is ${loc.href}`);
      assert(!roomRequests.some((r) => r.startsWith("POST") && r.endsWith("/events")), "no event posted before joining");
      assert((await a.$eval("#composerInput", (t) => t.value)) === "Hello team, the checkout build is ready for review.", "first message waits in composer");
      await waitText(a, "#aboutBody", "No About yet");
      // Agents that open the link in a browser are pointed at the CLI, visibly and in the accessibility tree.
      const cli = (await (await fetch(`${origin}/api/v1/info`)).json()).cli_command;
      await waitText(a, ".log__cmd", `${cli} join '<link>'`);
      const note = await a.$eval("#agentRoomNote", (el) => el.textContent);
      assert(note.includes("Note for AI agents") && note.includes(`${cli} file put`), `agent note: ${note}`);
      assert(await visible(a, "#joinAboutField"), "the first to post is asked what the room is for");
      await shot(a, "flow-02-room-name-prompt-1280x720");
    });

    await step("A gives a name and what the room is for; the join, the About and the first message are published", async () => {
      await a.type("#joinName", "Kamola");
      await a.type("#joinRole", "team lead");
      await a.type("#joinAbout", "Checkout v2: the web team and the Unity client agree on purchase events. Contracts live in event-schema.");
      await a.click("#joinGo");
      await waitText(a, ".msg__body", "the checkout build is ready");
      await waitText(a, "#aboutBody", "Contracts live in event-schema.");
      await waitText(a, "#aboutBody", "by Kamola");
      await waitText(a, "#peopleList", "Kamola");
      await waitText(a, ".activity", "Kamola joined (team lead, Browser)");
      assert(!(await visible(a, "#joinForm")), "join form closed");
      const where = await a.evaluate(() => ({
        session: Object.keys(sessionStorage).filter((k) => k.startsWith("lincor:room:")).length,
        local: Object.keys(localStorage).filter((k) => k.startsWith("lincor:room:")).length,
      }));
      assert(where.session === 1 && where.local === 0, `key kept in sessionStorage only: ${JSON.stringify(where)}`);
    });

    const b = await ctxB.newPage();
    watch(b, "B");
    debugPages.push(["B", b]);
    await b.setViewport({ width: 1280, height: 720 });

    await step("B opens the link in another browser context and reads without joining", async () => {
      await b.goto(link, { waitUntil: "domcontentloaded" });
      await waitText(b, ".msg__body", "the checkout build is ready");
      const loc = await b.evaluate(() => ({ path: location.pathname, hash: location.hash }));
      assert(loc.path === "/r" && loc.hash === "", `fragment removed after load: ${JSON.stringify(loc)}`);
      assert(!(await visible(b, "#joinForm")), "no name prompt while only reading");
      await waitText(b, "#peopleList", "Kamola");
      await waitText(b, "#aboutBody", "agree on purchase events");
    });

    await step("B replies mentioning A; the name prompt appears first", async () => {
      const cid = await messageCid(b, "the checkout build is ready");
      assert(cid, "found A's message");
      await clickLive(b, `[data-reply="${cid}"]`);
      await waitText(b, "#replyBar", "Replying to Kamola");
      // Typing @ suggests who to address; Enter inserts the handle instead of sending.
      await b.type("#composerInput", "@kam");
      await b.waitForSelector("#mentionList:not([hidden])");
      await waitText(b, "#mentionList .mention-opt", "Kamola");
      await shot(b, "flow-03a-mention-suggestions-1280x720");
      await b.keyboard.press("Enter");
      assert((await b.$eval("#composerInput", (t) => t.value)) === "@kamola ", "Enter inserts the picked handle");
      assert(!(await visible(b, "#mentionList")), "suggestions close after picking");
      await b.type("#composerInput", "looks good, I'll take the payment screen");
      await b.keyboard.press("Enter");
      await b.waitForSelector("#joinForm:not([hidden])");
      await waitText(b, "#joinTitle", "tell the room who you are");
      assert(!(await visible(b, "#joinAboutField")), "no About question once the room has one");
      await shot(b, "flow-03-b-name-prompt-1280x720");
      await b.type("#joinName", "Bobur");
      await b.keyboard.press("Enter");
      await waitText(b, ".msg__body", "I'll take the payment screen");
      await waitText(b, "#peopleList", "Bobur");
      assert((await b.$eval("#composerInput", (t) => t.value)) === "", "composer cleared");
    });

    await step(`A sees B's reply live (${EXTERNAL ? "WebSocket" : "long-poll fallback"}), with the mention and reply highlighted`, async () => {
      await waitText(a, ".msg__body", "I'll take the payment screen", 20_000);
      const view = await a.evaluate(() => {
        const msg = [...document.querySelectorAll(".msg")].find((m) => m.textContent.includes("payment screen"));
        return {
          mine: msg?.querySelector(".mention--me")?.textContent,
          forMe: msg?.classList.contains("msg--for-me"),
          reply: msg?.querySelector(".msg__reply")?.textContent,
          transport: window.__lincorTransport,
          via: window.__lincor?.eventsVia,
        };
      });
      assert(view.mine === "@kamola", `mention of A highlighted: ${JSON.stringify(view)}`);
      assert(view.forMe, "message addressed to A is marked");
      assert(view.reply?.includes("Reply to Kamola"), `reply line: ${view.reply}`);
      if (EXTERNAL) {
        assert(view.transport === "ws", `transport is ws: ${view.transport}`);
        assert(view.via.ws > 0, `live events arrived over the WebSocket: ${JSON.stringify(view.via)}`);
      } else {
        assert(view.transport === "poll", `transport is poll: ${view.transport}`);
        assert(view.via.poll > 0, `live events arrived by long-poll: ${JSON.stringify(view.via)}`);
      }
    });

    await step("A creates a task from the composer; B moves it to done; A sees the status live", async () => {
      await a.click('.segment [data-mode="task"]');
      await waitText(a, "#sendBtn", "Create task");
      await a.click("#composerInput");
      await a.type("#composerInput", "Ship the payment screen @bo");
      await waitText(a, "#mentionList .mention-opt", "Bobur");
      await a.keyboard.press("Tab");
      assert((await a.$eval("#composerInput", (t) => t.value)) === "Ship the payment screen @bobur ", "Tab inserts the assignee");
      await shiftEnter(a);
      await a.type("#composerInput", "Use the receipt view from the contract.");
      await a.keyboard.press("Enter");
      await waitText(a, ".task-card h3", "Ship the payment screen");
      const card = await a.evaluate(() => {
        const c = [...document.querySelectorAll(".task-card")].find((x) => x.textContent.includes("Ship the payment screen"));
        return { pill: c?.querySelector(".pill")?.textContent, desc: c?.querySelector(".task-card__desc")?.textContent, status: c?.querySelector(".status")?.textContent };
      });
      assert(card.pill === "@bobur" && card.desc?.includes("receipt view") && card.status === "Open", `task card: ${JSON.stringify(card)}`);
      await a.click('.segment [data-mode="message"]');

      await waitText(b, "#sideList .item__title", "Ship the payment screen", 20_000);
      const id = await b.evaluate(() => [...document.querySelectorAll("#sideList .item")].find((i) => i.textContent.includes("Ship the payment screen"))?.dataset.task);
      await clickLive(b, `[data-task-id="${id}"][data-task-status="in_progress"]`);
      await b.waitForSelector(`[data-task-id="${id}"][data-task-status="done"]`);
      await clickLive(b, `[data-task-id="${id}"][data-task-status="done"]`);
      await waitText(b, "#sideList", "Reopen");
      await waitText(a, ".activity", "moved “Ship the payment screen” to Done", 20_000);
      await waitText(a, '.task-card .status--done', "Done");
      await waitText(a, "#sideList .status--done", "Done");
    });

    const fileBytes = randomBytes(200_000 + 12_345);
    const filePath = join(work, "build-log.bin");
    await writeFile(filePath, fileBytes);
    const pdfBytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(30_000)]);
    const pdfPath = join(work, "Owner — Урок 1.pdf");
    await writeFile(pdfPath, pdfBytes);

    await step("A attaches two files at once; each is encrypted in the browser; B downloads identical bytes, A too from the Files tab", async () => {
      const input = await a.$("#fileInput");
      await input.uploadFile(filePath, pdfPath);
      await waitText(a, "#attachBar", "build-log.bin, Owner — Урок 1.pdf");
      await a.type("#composerInput", "Build log attached @bobur");
      await a.keyboard.press("Enter");
      await waitText(a, ".chip__name", "build-log.bin");
      await waitText(b, ".chip__name", "build-log.bin", 20_000);
      await waitText(b, ".chip__name", "Owner — Урок 1.pdf", 20_000);
      assert(!(await visible(a, "#attachBar")), "both files sent, nothing left staged");
      const cid = await messageCid(b, "Build log attached");
      await clickLive(b, `.msg[data-cid="${cid}"] [data-download]`);
      const saved = await waitForDownload(dlB, "build-log.bin");
      const got = await readFile(saved);
      assert(got.length === fileBytes.length && sha256(got) === sha256(fileBytes), "downloaded bytes are identical");
      await b.click('.tabs [data-side="files"]');
      await waitText(b, "#sideList .item__title", "build-log.bin");
      await a.click('.tabs [data-side="files"]');
      await clickLive(a, `#sideList [data-download="${cid}"]`);
      const own = await readFile(await waitForDownload(dlA, "build-log.bin"));
      assert(sha256(own) === sha256(fileBytes), "the uploader downloads identical bytes from the Files tab");
      await a.click('.tabs [data-side="tasks"]');
    });

    let agent;
    await step("An agent (core RoomSession in Node) joins and pins two versions of a contract", async () => {
      const { secret } = parseLink(link);
      agent = new RoomSession(origin, secret, newIdentity());
      await agent.sync();
      await agent.join({ name: "Ali's frontend agent", role: "frontend", client: "claude-code", kind: "agent", status: "Building the payment screen", repo: "web" });
      await agent.putArtifact("event-schema", utf8(JSON.stringify({ event: "purchase_completed", currency: "string" }, null, 2)), { note: "first draft" });
      await agent.putArtifact("event-schema", utf8(JSON.stringify({ event: "purchase_completed", currency: "ISO 4217 code" }, null, 2)), { note: "currency is ISO 4217" });
      await agent.say("@kamola contract event-schema v2 is pinned. @bobur please check the currency field.");
      await agent.client.setPresence(agent.identity.id, "listening").catch(() => undefined);
      await waitText(a, ".msg__body", "contract event-schema v2 is pinned", 20_000);
      await waitText(a, "#peopleList", "Ali's frontend agent");
      await waitText(a, "#peopleList", "Claude Code");
      await waitText(a, "#peopleList", "Building the payment screen");
    });

    await step("Hostile content stays text, and events that fail verification are ignored and counted", async () => {
      await agent.say(`<img src=x onerror="window.__xss=1"> <script>window.__xss=2</script> [x](javascript:window.__xss=3)`);
      // Someone with the room key (or the server) appends garbage that does not decrypt.
      await agent.client.post({ cid: "ZmFrZWZha2VmYWtlZmFrZQ", sender: agent.identity.id, data: "A".repeat(80) });
      await agent.say("after the forged event");
      await waitText(a, ".msg__body", "after the forged event", 20_000);
      const check = await a.evaluate(() => ({
        xss: window.__xss,
        imgs: document.querySelectorAll("#feedList img, #feedList script").length,
        jsLinks: [...document.querySelectorAll("#feedList a")].filter((x) => !/^https?:/.test(x.getAttribute("href") ?? "")).length,
        lock: document.getElementById("lock").title,
        rejected: window.__lincor?.rejected,
      }));
      assert(check.xss === undefined && check.imgs === 0 && check.jsLinks === 0, `no script ran or was inserted: ${JSON.stringify(check)}`);
      assert(check.rejected === 1 && check.lock.includes("1 event could not be verified"), `ignored event counted: ${JSON.stringify(check)}`);
    });

    await step("Feed and composer conveniences: copy a code block, New messages while scrolled up, paste or drop a file", async () => {
      await agent.say("Run the web tests:\n```\nnpm test -w @lincor/web\n```");
      await waitText(a, ".msg__body pre code", "npm test -w @lincor/web", 20_000);
      const cid = await messageCid(a, "Run the web tests");
      await clickLive(a, `.msg[data-cid="${cid}"] [data-copy-code]`);
      await waitText(a, `.msg[data-cid="${cid}"] [data-copy-code]`, "Copied");
      await shot(a, "flow-05b-code-copied-1280x720");
      const code = await a.evaluate(() => navigator.clipboard.readText()).catch(() => "");
      if (code) assert(code === "npm test -w @lincor/web", `copied code: ${JSON.stringify(code)}`);

      // Scrolled up into the history, a new message shows "New messages"; it takes you down and goes away.
      const scrollable = await a.evaluate(() => {
        const sc = document.getElementById("feedScroll");
        sc.scrollTop = 0;
        return sc.scrollHeight - sc.clientHeight;
      });
      assert(scrollable > 200, `the feed is long enough to scroll (${scrollable} px)`);
      await sleep(150);
      await agent.say("one more thing while you read the history");
      await a.waitForSelector("#jumpLatest:not([hidden])", { timeout: 20_000 });
      await shot(a, "flow-05a-new-messages-1280x720");
      await a.click("#jumpLatest");
      await a.waitForSelector("#jumpLatest", { hidden: true });

      // A pasted or dropped file is attached like one picked with the paperclip.
      const give = (how) =>
        a.evaluate((how) => {
          const dt = new DataTransfer();
          dt.items.add(new File(["notes"], `${how}.txt`, { type: "text/plain" }));
          if (how === "pasted") {
            document.getElementById("composerInput").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
          } else {
            for (const type of ["dragenter", "dragover", "drop"]) {
              document.getElementById("feedScroll").dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
            }
          }
        }, how);
      await give("pasted");
      await waitText(a, "#attachBar", "pasted.txt");
      await give("dropped");
      await waitText(a, "#attachBar", "dropped.txt");
      assert(!(await a.$eval("#room", (r) => r.classList.contains("is-drop"))), "drop overlay cleared");
      await a.click("#attachCancel");
      assert(!(await visible(a, "#attachBar")), "attachment removed");
    });

    await step("About: an agent rewrites it and hostile text stays text; A edits it in Room settings and B sees it live", async () => {
      await agent.setMeta({ description: `<img src=x onerror="window.__xss=4"> Checkout v2 and refunds. Contracts: event-schema, refund-api.` });
      await waitText(a, "#aboutBody", "Checkout v2 and refunds", 20_000);
      await waitText(a, "#aboutBody", "by Ali's frontend agent");
      await waitText(a, ".activity", "Ali's frontend agent updated About this room");
      const safe = await a.evaluate(() => ({ xss: window.__xss, imgs: document.querySelectorAll("#aboutBody img, #feedList img").length }));
      assert(safe.xss === undefined && safe.imgs === 0, `About stays text: ${JSON.stringify(safe)}`);
      await a.click("#aboutEdit");
      await a.waitForSelector("#menuDialog[open]");
      await a.waitForFunction(() => document.activeElement?.id === "aboutInput", { timeout: 3000 }).catch(() => assert(false, "the editor has focus"));
      assert((await a.$eval("#aboutInput", (t) => t.value)).includes("refund-api"), "the editor holds the current About");
      await a.$eval("#aboutInput", (t) => (t.value = ""));
      await a.type("#aboutInput", "Checkout v2 and refunds. Contracts: event-schema, refund-api. Nobody pushes to main.");
      await shot(a, "flow-04b-about-editor-1280x720");
      await a.click('#aboutForm button[type="submit"]');
      await waitText(a, "#aboutBody", "Nobody pushes to main.");
      await waitText(b, "#aboutBody", "Nobody pushes to main.", 20_000);
      await waitText(b, "#aboutBody", "by Kamola");
      await shot(b, "flow-04c-about-1280x720");
    });

    await step("Contracts: open the artifact, see version history and content, download a version", async () => {
      await a.click('.tabs [data-side="contracts"]');
      await waitText(a, "#sideList .item__title", "event-schema");
      await clickLive(a, '#sideList [data-artifact="event-schema"]');
      await a.waitForSelector("#contractDialog[open]");
      await waitText(a, "#contractVersions", "version 2 (latest)");
      await waitText(a, "#contractContent", "ISO 4217 code");
      await waitText(a, "#contractMeta", "currency is ISO 4217");
      await shot(a, "flow-04-contract-1280x720");
      await clickLive(a, '#contractVersions [data-version="1"]');
      await waitText(a, "#contractContent", '"currency": "string"');
      await a.click("#contractDownload");
      const saved = await waitForDownload(dlA, "event-schema.v1.json");
      assert((await readFile(saved, "utf8")).includes('"currency": "string"'), "downloaded version 1");
      await a.click("#contractDialog [data-close]");
      await a.click('.tabs [data-side="tasks"]');
    });

    await step("A person pins contracts from the browser: a new version and a new contract; the agent reads them", async () => {
      await a.click('.tabs [data-side="contracts"]');
      await clickLive(a, '#sideList [data-artifact="event-schema"]');
      await a.waitForSelector("#contractDialog[open]");
      await a.click("#contractEditBtn");
      await waitText(a, "#contractSave", "Pin version 3");
      await a.click("#contractText", { clickCount: 3 });
      await a.evaluate(() => (document.getElementById("contractText").value = ""));
      await a.type("#contractText", '{"event":"purchase_completed","currency":"ISO 4217 code","amount_minor":"integer"}');
      await a.type("#contractNote", "amount in minor units");
      await a.click("#contractSave");
      await waitText(a, "#contractVersions", "version 3 (latest)");
      await waitText(a, "#contractMeta", "amount in minor units");
      await a.click("#contractDialog [data-close]");
      await clickLive(a, "#sideList [data-new-contract]");
      await a.waitForSelector("#contractDialog[open]");
      await a.type("#contractName", "api-contract");
      await a.type("#contractText", "openapi: 3.1.0\npaths:\n  /v1/purchases: {}\n");
      await a.click("#contractSave");
      await waitText(a, "#contractTitle", "api-contract");
      await waitText(a, "#contractVersions", "version 1 (latest)");
      await a.click("#contractDialog [data-close]");
      await agent.sync();
      const v3 = new TextDecoder().decode((await agent.readArtifact("event-schema")).content);
      assert(v3.includes("amount_minor"), `agent reads version 3: ${v3}`);
      const api = new TextDecoder().decode((await agent.readArtifact("api-contract")).content);
      assert(api.startsWith("openapi: 3.1.0"), `agent reads the new contract: ${api}`);
      await a.click('.tabs [data-side="tasks"]');
    });

    await step("Reloading A restores the room from sessionStorage as the same participant", async () => {
      await a.reload({ waitUntil: "domcontentloaded" });
      await waitText(a, ".msg__body", "contract event-schema v2 is pinned");
      assert(!a.url().includes("#"), `no fragment after reload: ${a.url()}`);
      await waitText(a, "#peopleList .person__name", "Kamola (you)");
      await a.type("#composerInput", "Back after a reload, same identity.");
      await a.keyboard.press("Enter");
      await waitText(a, ".msg__body", "Back after a reload");
      assert(!(await visible(a, "#joinForm")), "no second name prompt");
      await waitText(b, ".msg__body", "Back after a reload", 20_000);
    });

    await step("Room menu: rename, message TTL and remember-in-this-browser", async () => {
      await a.click("#menuBtn");
      await a.waitForSelector("#menuDialog[open]");
      await shot(a, "flow-05-menu-1280x720");
      await a.click("#renameInput", { clickCount: 3 });
      await a.type("#renameInput", "Checkout v2");
      await a.click('#renameForm button[type="submit"]');
      await waitText(a, "#roomName", "Checkout v2");
      await waitText(b, "#roomName", "Checkout v2", 20_000);

      await a.click("#menuBtn");
      await a.select("#ttlSelect", "30");
      await a.click('#ttlForm button[type="submit"]');
      await waitText(b, ".activity", "set messages to disappear after 30 days", 20_000);

      await a.click("#menuBtn");
      await a.click("#rememberToggle");
      let where = await a.evaluate(() => ({
        session: Object.keys(sessionStorage).filter((k) => k.startsWith("lincor:room:")).length,
        local: Object.keys(localStorage).filter((k) => k.startsWith("lincor:room:")).length,
      }));
      assert(where.local === 1 && where.session === 0, `remembered in localStorage: ${JSON.stringify(where)}`);
      // Home lists rooms remembered in this browser; going there and back needs no reload.
      await a.click("#menuDialog [data-close]");
      await a.click(".bar .wordmark");
      await a.waitForSelector("#home:not([hidden])");
      assert((await a.evaluate(() => location.pathname)) === "/", "home at /");
      await waitText(a, "#roomsOpen", "Your rooms (1)");
      await a.click("#roomsOpen");
      await waitText(a, "#roomsList .rooms__name", "Checkout v2");
      await clickLive(a, "#roomsList [data-open-room]");
      await a.waitForSelector("#room:not([hidden])");
      await waitText(a, ".msg__body", "Back after a reload");
      assert((await a.evaluate(() => location.pathname + location.hash)) === "/r", "room at /r without fragment");
      await a.click("#menuBtn");
      await a.waitForSelector("#menuDialog[open]");
      assert(await a.$eval("#rememberToggle", (c) => c.checked), "toggle shows remembered");
      await a.click("#rememberToggle");
      where = await a.evaluate(() => ({
        session: Object.keys(sessionStorage).filter((k) => k.startsWith("lincor:room:")).length,
        local: Object.keys(localStorage).filter((k) => k.startsWith("lincor:room:")).length,
      }));
      assert(where.local === 0 && where.session === 1, `back to the tab only: ${JSON.stringify(where)}`);
      await a.click("#menuDialog [data-close]");
    });

    await step("Delete room asks for confirmation, shows a restore banner everywhere, and restore works", async () => {
      await a.click("#menuBtn");
      await a.click("#deleteStart");
      await waitText(a, "#deleteConfirm", "Anyone with the link can restore it within 24 hours");
      await a.click("#deleteGo");
      await a.waitForSelector("#deletedBanner:not([hidden])");
      await waitText(a, "#deletedBanner", "This room is deleted");
      assert(await a.$eval("#composerInput", (t) => t.disabled), "composer disabled while deleted");
      await shot(a, "flow-06-deleted-1280x720");
      await b.waitForSelector("#deletedBanner:not([hidden])", { timeout: 20_000 });
      await a.click("#restoreBtn");
      await a.waitForSelector("#deletedBanner", { hidden: true });
      await waitText(a, ".msg__body", "Back after a reload");
      await b.waitForSelector("#deletedBanner", { hidden: true, timeout: 25_000 });
    });

    await step("A damaged link shows the error note and drops the broken key from the URL", async () => {
      const p = await ctxB.newPage();
      watch(p, "B2");
      debugPages.push(["B2", p]);
      await p.setViewport({ width: 390, height: 844 });
      await p.goto(`${origin}/r#${key.slice(0, -6)}`, { waitUntil: "domcontentloaded" });
      await p.waitForSelector("#badLink:not([hidden])");
      await waitText(p, "#badLink", "This room link is incomplete");
      assert(!(await visible(p, "#room")), "room not opened");
      assert(!p.url().includes("#"), `broken key removed from URL: ${p.url()}`);
      await shot(p, "flow-07-damaged-link-390x844");
      await p.goto(`${origin}/r#0OIl-not-a-key`, { waitUntil: "domcontentloaded" });
      await p.waitForSelector("#badLink:not([hidden])");
      await p.close();
    });

    await step("Phone layout: bottom tabs switch between Chat, People, Tasks, Contracts and Files", async () => {
      await b.setViewport({ width: 390, height: 844 });
      await sleep(200);
      assert(await visible(b, ".nav"), "bottom tabs visible");
      assert(!(await visible(b, ".people")) && (await visible(b, ".feed")), "chat first");
      await b.click('.nav [data-view="people"]');
      assert(await visible(b, ".people"), "people pane");
      assert(await visible(b, "#aboutBody"), "About at the top of the people pane");
      assert(!(await visible(b, ".feed")), "feed hidden");
      await shot(b, "phone-people-390x844");
      await b.click('.nav [data-view="tasks"]');
      await waitText(b, "#sideList", "Ship the payment screen");
      await shot(b, "phone-tasks-390x844");
      await b.click('.nav [data-view="contracts"]');
      await waitText(b, "#sideList", "event-schema");
      await b.click('.nav [data-view="files"]');
      await waitText(b, "#sideList", "build-log.bin");
      await b.click('.nav [data-view="chat"]');
      assert(await visible(b, ".feed"), "back to chat");
    });

    await step("No page scroll in the room at any size, no sideways scroll on home", async () => {
      const ctxC = await browser.createBrowserContext();
      const c = await ctxC.newPage();
      watch(c, "C");
      for (const [w, h] of VIEWPORTS) {
        const size = `${w}x${h}`;
        await c.setViewport({ width: w, height: h });
        await c.goto(`${origin}/`, { waitUntil: "networkidle0" });
        await c.evaluate(() => document.fonts.ready);
        await noPageScroll(c, `home ${size}`, { vertical: false });
        await shot(c, `home-${size}`);
        await c.screenshot({ path: join(SHOTS, `home-full-${size}.png`), fullPage: true });

        await a.setViewport({ width: w, height: h });
        await sleep(300);
        await noPageScroll(a, `room ${size}`);
        await shot(a, `room-${size}`);

        // A reader who starts typing gets the inline name prompt; it must fit too.
        await c.goto(link, { waitUntil: "domcontentloaded" });
        await waitText(c, ".msg__body", "Back after a reload");
        await c.type("#composerInput", "Hi from a new reader");
        await c.keyboard.press("Enter");
        await c.waitForSelector("#joinForm:not([hidden])");
        await noPageScroll(c, `room name prompt ${size}`);
        await shot(c, `room-name-prompt-${size}`);
      }
      await ctxC.close();
    });

    assert(pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);
  } finally {
    await browser.close();
    server.stop();
    await rm(work, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(`\nall ${stepNo} steps passed in ${((Date.now() - t0) / 1000).toFixed(1)} s; screenshots: ${SHOTS}`);
    process.exit(0);
  })
  .catch((e) => {
    if (!failures) console.log(`\nfailed: ${e?.stack ?? e}`);
    console.log(`\n${failures || 1} failure(s); screenshots so far: ${SHOTS}`);
    process.exit(1);
  });
