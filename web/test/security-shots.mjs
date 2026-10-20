// Screenshots and checks of /security against a running server:
//   node web/test/security-shots.mjs <base url> <out dir>
// Checks: the live demo seals what is typed (the stored row changes, the teammate sees the text, a wrong key
// fails), nothing goes to the network while typing, and the page has no sideways scroll.
import puppeteer from "puppeteer-core";
import { join } from "node:path";

const [base = "http://127.0.0.1:8080", out = "/tmp/lincor-security-shots"] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const fail = (msg) => {
  console.error(`not ok: ${msg}`);
  process.exitCode = 1;
};
try {
  const page = await browser.newPage();
  const requests = [];
  // Hermetic: only this server answers (no web fonts); every request is recorded.
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    requests.push(r.url());
    if (r.url().startsWith(base) || r.url().startsWith("data:")) r.continue();
    else r.abort();
  });
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewport({ width: w, height: h });
    // One retry: a fresh browser's first navigation has been seen to stall in CI-like runs.
    await page.goto(`${base}/security`, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => page.goto(`${base}/security`, { waitUntil: "domcontentloaded", timeout: 30_000 }));
    await page.waitForFunction(() => document.querySelector("#demoRow dd.row__data")?.textContent.length > 40);
    const before = requests.length;
    const first = await page.$eval("#demoRow dd.row__data", (d) => d.textContent);
    await page.click("#demoInput", { clickCount: 3 });
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.type("#demoInput", "Our Stripe test key is sk_test_123 <script>alert(1)</script>");
    await page.waitForFunction((f) => document.querySelector("#demoRow dd.row__data")?.textContent !== f, {}, first);
    await new Promise((r) => setTimeout(r, 400));
    const view = await page.evaluate(() => ({
      data: document.querySelector("#demoRow dd.row__data").textContent,
      open: document.getElementById("demoOpen").textContent,
      wrong: document.getElementById("demoWrong").textContent,
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      scripts: document.querySelectorAll("#demoOpen script, #demoRow script").length,
    }));
    if (view.data.includes("sk_test") || view.data.includes("Stripe")) fail("plaintext in the stored row");
    if (view.open !== "Our Stripe test key is sk_test_123 <script>alert(1)</script>") fail(`teammate sees: ${view.open}`);
    if (!view.wrong.startsWith("cannot decrypt")) fail(`wrong key: ${view.wrong}`);
    if (view.sideways) fail(`sideways scroll at ${w}px`);
    if (view.scripts) fail("typed markup became elements");
    // What would matter: anything to the API or to another host while typing (assets such as the favicon do not).
    const sent = requests.slice(before).filter((u) => u.includes("/api/") || !u.startsWith(base));
    if (sent.length) fail(`network while typing: ${sent.join(", ")}`);
    await page.screenshot({ path: join(out, `security-${w}x${h}.png`), fullPage: true });
    console.log(`ok ${w}x${h}`);
  }
} finally {
  await browser.close();
}
