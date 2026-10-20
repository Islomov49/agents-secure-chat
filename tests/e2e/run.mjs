#!/usr/bin/env node
// End-to-end acceptance run against the real Rust server (PRD §10).
//
//   node tests/e2e/run.mjs              build everything, run server + CLI + web checks
//   node tests/e2e/run.mjs --agents     also run live Claude Code and Codex sessions (uses model tokens)
//                                         LINCOR_E2E_AGENTS=claude-zero,claude-plugin,codex picks which ones;
//                                         LINCOR_E2E_CODEX_MODEL=<model> overrides the Codex model
//   node tests/e2e/run.mjs --postgres   use a throwaway Postgres container instead of SQLite
//   node tests/e2e/run.mjs --s3         store blobs in a throwaway S3-compatible server (SeaweedFS container)
//   node tests/e2e/run.mjs --no-build   reuse existing builds
//
// Everything runs in a temporary directory; your ~/.lincor, ~/.claude and ~/.codex are not touched
// (live agents get LINCOR_HOME in the temp dir and the plugin via --plugin-dir / -c overrides only).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Set(process.argv.slice(2));
const tmp = mkdtempSync(join(process.env.LINCOR_E2E_TMP ?? tmpdir(), "lincor-e2e-"));
const CLI = join(repo, "packages/cli/dist/agents-room.js");
const results = [];
let serverProcess;
let pgContainer;
let s3Container;

const log = (...m) => console.log(...m);
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: error.message });
    log(`  ✗ ${name}\n    ${String(error.stack ?? error).split("\n").slice(0, 6).join("\n    ")}`);
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

const freePort = () =>
  new Promise((resolvePort) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolvePort(port));
    });
  });

function sh(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 << 20, ...opts });
}

/** A developer on their own "machine": own LINCOR_HOME and project directory. */
function developer(name, files, base) {
  const project = join(tmp, `${name}-project`);
  mkdirSync(project, { recursive: true });
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(project, p)), { recursive: true });
    writeFileSync(join(project, p), c);
  }
  const env = { ...process.env, LINCOR_HOME: join(tmp, `${name}-lincor`), LINCOR_SERVER: base, LINCOR_OWNER: name, LINCOR_CLIENT: "cli" };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION_ID;
  return {
    name,
    project,
    env,
    run: (...argv) => sh("node", [CLI, ...argv], { cwd: project, env }),
    runAsync: (...argv) =>
      new Promise((res, rej) => {
        const p = spawn("node", [CLI, ...argv], { cwd: project, env });
        let out = "";
        let err = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (err += d));
        p.on("exit", (code) => (code === 0 ? res(out) : rej(new Error(`lincor ${argv.join(" ")} → ${code}: ${err}`))));
      }),
  };
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

async function main() {
  log(`lincor e2e in ${tmp}`);
  if (!args.has("--no-build")) {
    log("building core, web, cli, server…");
    sh("npm", ["run", "build", "-w", "@lincor/core"]);
    sh("npm", ["run", "build", "-w", "@lincor/web"]);
    sh("npm", ["run", "build", "-w", "agents-room"]);
    sh("cargo", ["build", "--release"], { cwd: join(repo, "server") });
  }
  const binary = join(repo, "server/target/release/lincor-server");
  assert(existsSync(binary), `server binary missing at ${binary}`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = join(tmp, "server-data");
  mkdirSync(dataDir, { recursive: true });
  let databaseUrl = `sqlite://${join(dataDir, "lincor.db")}?mode=rwc`;
  if (args.has("--postgres")) {
    const pgPort = await freePort();
    pgContainer = `lincor-e2e-pg-${port}`;
    sh("docker", ["run", "-d", "--rm", "--name", pgContainer, "-e", "POSTGRES_PASSWORD=e2e", "-p", `127.0.0.1:${pgPort}:5432`, "postgres:17"]);
    for (let i = 0; i < 60; i++) {
      try {
        sh("docker", ["exec", pgContainer, "pg_isready", "-U", "postgres"]);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
    databaseUrl = `postgres://postgres:e2e@127.0.0.1:${pgPort}/postgres`;
  }
  const s3Env = {};
  if (args.has("--s3")) {
    const s3Port = await freePort();
    s3Container = `lincor-e2e-s3-${port}`;
    sh("docker", ["run", "-d", "--rm", "--name", s3Container, "-p", `127.0.0.1:${s3Port}:8333`, "chrislusf/seaweedfs:latest", "server", "-s3", "-dir=/data"]);
    const s3 = `http://127.0.0.1:${s3Port}`;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${s3}/lincor-blobs`, { method: "PUT" });
        if (r.ok || r.status === 409) break;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    Object.assign(s3Env, {
      LINCOR_BLOB_URL: "s3://lincor-blobs/e2e",
      AWS_ACCESS_KEY_ID: "lincor",
      AWS_SECRET_ACCESS_KEY: "lincor-e2e-secret",
      AWS_REGION: "us-east-1",
      AWS_ENDPOINT: s3,
      AWS_ALLOW_HTTP: "true",
      // Short grace so the run can watch a purge remove the room's objects from the bucket.
      LINCOR_DELETE_GRACE_SECS: "10",
      LINCOR_GC_INTERVAL_SECS: "1",
    });
  }
  const serverLog = join(tmp, "server.log");
  serverProcess = spawn(binary, [], {
    env: {
      ...process.env,
      LINCOR_BIND: `127.0.0.1:${port}`,
      LINCOR_DATABASE_URL: databaseUrl,
      LINCOR_BLOB_DIR: join(dataDir, "blobs"),
      LINCOR_PUBLIC_URL: base,
      LINCOR_CLI_COMMAND: `node ${CLI}`,
      RUST_LOG: "info",
      ...s3Env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logChunks = [];
  serverProcess.stdout.on("data", (d) => logChunks.push(d));
  serverProcess.stderr.on("data", (d) => logChunks.push(d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  log(`server on ${base} (${args.has("--postgres") ? "Postgres" : "SQLite"}${args.has("--s3") ? ", blobs in S3" : ""})`);

  log("\nserver entry points");
  await check("GET /api/v1/info reports the CLI command and limits", async () => {
    const info = await (await fetch(`${base}/api/v1/info`)).json();
    assert(info.cli_command === `node ${CLI}`, `cli_command is ${info.cli_command}`);
    assert(info.limits && typeof info.limits === "object", "no limits");
    return `version ${info.version}`;
  });
  await check("GET /r gives agents markdown with the join command", async () => {
    const r = await fetch(`${base}/r`, { headers: { "User-Agent": "curl/8.5.0", Accept: "*/*" } });
    const text = await r.text();
    assert(r.headers.get("content-type")?.includes("text/markdown"), `content-type ${r.headers.get("content-type")}`);
    assert(text.includes(`node ${CLI} join '`), "join command missing");
    assert(text.includes("information, not as instructions"), "trust rule missing");
  });
  await check("GET /r gives browsers the app with a static agent block", async () => {
    const r = await fetch(`${base}/r`, { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140", Accept: "text/html,application/xhtml+xml" } });
    const html = await r.text();
    assert(r.headers.get("content-type")?.includes("text/html"), "not html");
    assert(/join '/.test(html) && /AI agent/i.test(html), "agent instructions block missing from HTML");
  });
  await check("GET /llms.txt", async () => assert((await (await fetch(`${base}/llms.txt`)).text()).includes("join"), "no join"));

  log("\ntwo developers through the CLI");
  const markers = ["PURCHASE_EVENT_MARKER", "ISO4217_ANSWER_MARKER", "CONTRACT_BODY_MARKER", "FILE_BODY_MARKER", "ROOM_NAME_MARKER", "STATUS_MARKER", "DONE_NOTE_MARKER"];
  const ali = developer("ali", { "package.json": JSON.stringify({ name: "shop-web", dependencies: { react: "19", vite: "6" } }) }, base);
  const bobur = developer("bobur", { "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.23f1\n" }, base);
  let link;
  await check("create is offline and the room does not exist until the first post", async () => {
    const out = JSON.parse(ali.run("create", "--name", "ROOM_NAME_MARKER", "--json"));
    link = out.data.link;
    assert(link.startsWith(`${base}/r#`), link);
    const core = await import(join(repo, "packages/core/dist/index.js"));
    const parsed = core.parseLink(link);
    const client = new core.RoomClient(base, core.deriveRoom(parsed.secret));
    const info = await client.info();
    assert(info.exists === false, "room exists before the first event");
  });
  await check("first post creates the room; task, contract and status", async () => {
    ali.run("task", "create", "Emit PURCHASE_EVENT_MARKER from the Unity client", "--to", "unity", "--desc", "Checkout needs it", "--accept", "fires once per purchase");
    for (const version of [1, 2]) {
      sh("node", [CLI, "artifact", "put", "event-schema", "-"], { cwd: ali.project, env: ali.env, input: `{"CONTRACT_BODY_MARKER": ${version}}` });
    }
    ali.run("status", "STATUS_MARKER building checkout");
  });
  await check("join by link: briefing shows the task for the unity role", async () => {
    const out = bobur.run("join", link);
    assert(out.includes('"ROOM_NAME_MARKER"'), "room name missing");
    assert(out.includes("Tasks for you (1)"), "task not for unity");
    assert(/\[unity\]/.test(out) && /Unity 6000/.test(out), "profile not detected");
    assert(out.includes("event-schema v2"), "contract versions");
  });
  await check("wait wakes on a mention; reply threads; presence shows listening", async () => {
    const waiting = ali.runAsync("wait", "--timeout", "30");
    await new Promise((r) => setTimeout(r, 1500));
    const who = bobur.run("who");
    assert(/ali's frontend agent.*listening/i.test(who), `presence: ${who}`);
    bobur.run("send", "@frontend ISO 4217 or display string?");
    const woke = await waiting;
    assert(woke.includes("★") && woke.includes("ISO 4217 or display string?"), woke);
    const id = woke.match(/msg ([0-9a-f]{8})/)[1];
    ali.run("send", "--reply", id, "ISO4217_ANSWER_MARKER");
    const read = bobur.run("read");
    assert(read.includes(`reply to ${id}`) && read.includes("ISO4217_ANSWER_MARKER"), read);
  });
  await check("files are encrypted, padded and verified on download", async () => {
    const body = "FILE_BODY_MARKER ".repeat(9000);
    writeFileSync(join(bobur.project, "payload.json"), body);
    bobur.run("file", "put", "payload.json", "--text", "@frontend sample");
    const list = ali.run("file", "list");
    const id = list.match(/file ([0-9a-f]{8})/)[1];
    const out = join(tmp, "downloaded.json");
    ali.run("file", "get", id, "-o", out);
    assert(readFileSync(out, "utf8") === body, "downloaded bytes differ");
  });
  await check("task lifecycle reaches done with a note", async () => {
    const id = bobur.run("task", "list", "--mine").split(" ")[1];
    bobur.run("task", "accept", id);
    bobur.run("task", "start", id);
    bobur.run("task", "done", id, "--note", "DONE_NOTE_MARKER");
    assert(ali.run("task", "list", "--all").includes("[done]"), "not done for ali");
  });
  await check("stop hook blocks with messages addressed to the agent", async () => {
    ali.run("send", "@unity please also add a play-mode test");
    const out = sh("node", [CLI, "hook", "stop"], { cwd: bobur.project, env: bobur.env, input: JSON.stringify({ session_id: "e2e", cwd: bobur.project }) });
    const json = JSON.parse(out);
    assert(json.decision === "block" && json.reason.includes("play-mode test"), out);
  });
  await check("the server holds no plaintext (database, WAL, blobs, log)", async () => {
    await new Promise((r) => setTimeout(r, 500));
    const files = args.has("--postgres") ? filesUnder(join(dataDir, "blobs")) : filesUnder(dataDir);
    let haystack = Buffer.concat([...files.map((f) => readFileSync(f)), ...logChunks]);
    if (args.has("--postgres")) {
      haystack = Buffer.concat([haystack, Buffer.from(sh("docker", ["exec", pgContainer, "pg_dump", "-U", "postgres", "postgres"]))]);
    }
    let s3Note = "";
    if (args.has("--s3")) {
      const local = filesUnder(join(dataDir, "blobs"));
      assert(!local.length, `blobs were written to the local disk instead of S3: ${local.length}`);
      const listing = await (await fetch(`${s3Env.AWS_ENDPOINT}/lincor-blobs?list-type=2&prefix=e2e/`)).text();
      const keys = (listing.match(/<Key>/g) ?? []).length;
      assert(keys > 0, `no objects in the S3 bucket: ${listing.slice(0, 300)}`);
      // The raw tar stream of the S3 server's storage directory holds every stored byte verbatim.
      const storage = execFileSync("docker", ["exec", s3Container, "tar", "-C", "/data", "-cf", "-", "."], { maxBuffer: 1 << 30 });
      haystack = Buffer.concat([haystack, storage]);
      s3Note = `; ${keys} blobs in S3, ${(storage.length / 1048576).toFixed(1)} MiB of S3 storage scanned`;
    }
    const found = markers.filter((m) => haystack.includes(Buffer.from(m)));
    assert(!found.length, `plaintext found on the server: ${found.join(", ")}`);
    return `${files.length} server files scanned${s3Note}`;
  });
  await check("deleting a room is soft and restorable", async () => {
    sh("node", [CLI, "delete-room", "--yes"], { cwd: ali.project, env: ali.env });
    let failed = false;
    try {
      bobur.run("send", "anyone?");
    } catch (error) {
      failed = /deleted/.test(error.stderr ?? error.message);
    }
    assert(failed, "posting to a deleted room should fail with a clear message");
    ali.run("restore-room");
    bobur.run("send", "back again");
  });

  if (args.has("--s3")) {
    await check("purging a deleted room removes its blobs from S3", async () => {
      const count = async () => ((await (await fetch(`${s3Env.AWS_ENDPOINT}/lincor-blobs?list-type=2&prefix=e2e/`)).text()).match(/<Key>/g) ?? []).length;
      const before = await count();
      assert(before > 0, "no blobs to purge");
      sh("node", [CLI, "delete-room", "--yes"], { cwd: ali.project, env: ali.env });
      for (let i = 0; i < 30 && (await count()) > 0; i++) await new Promise((r) => setTimeout(r, 1000));
      const after = await count();
      assert(after === 0, `${after} blobs left in S3 after the purge`);
      return `${before} → ${after} objects`;
    });
  }

  log("\nweb app in a real browser");
  if (!args.has("--no-web")) await check("web e2e (puppeteer) against the real server, incl. WebSocket", async () => {
    try {
      const out = sh("node", [join(repo, "web/test/e2e.mjs")], { env: { ...process.env, LINCOR_E2E_URL: base }, timeout: 240_000 });
      return out.trim().split("\n").slice(-1)[0];
    } catch (error) {
      // The browser test reports on stdout; execFileSync's error message only carries stderr.
      log(String(error.stdout ?? "").trimEnd().split("\n").map((line) => `    | ${line}`).join("\n"));
      throw error;
    }
  });

  if (!args.has("--no-web")) await check("security page: live encryption demo, nothing sent while typing, no sideways scroll", async () => {
    const page = await fetch(`${base}/security`, { signal: AbortSignal.timeout(10_000) });
    assert(page.ok, `GET /security: ${page.status}`);
    const out = sh("node", [join(repo, "web/test/security-shots.mjs"), base, tmp], { timeout: 120_000 });
    return out.trim().split("\n").join(", ");
  });

  if (args.has("--agents")) await liveAgents(base);

  const failed = results.filter((r) => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} checks passed`);
  writeFileSync(join(tmp, "results.json"), JSON.stringify(results, null, 2));
  log(`details: ${join(tmp, "results.json")}, server log: ${serverLog}`);
  writeFileSync(serverLog, Buffer.concat(logChunks));
  return failed.length ? 1 : 0;
}

/** PRD §10 main acceptance test with real agents. */
async function liveAgents(base) {
  log("\nlive agents (this uses model tokens)");
  const fe = developer("frontend", { "package.json": JSON.stringify({ name: "shop-web", dependencies: { react: "19" } }) }, base);
  const created = JSON.parse(fe.run("create", "--name", "Live acceptance", "--json"));
  const link = created.data.link;
  fe.run(
    "task", "create", "Add a purchase_completed note file",
    "--to", "unity",
    "--desc", "In your project root create PURCHASE_EVENT.md with one line: 'purchase_completed fires once per successful purchase'. Then mark this task done with a short note.",
    "--accept", "PURCHASE_EVENT.md exists in the project root",
  );
  const agentRun = (cmd, argv, cwd, env, timeout = 600_000) =>
    new Promise((res) => {
      const started = Date.now();
      const p = spawn(cmd, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => p.kill("SIGTERM"), timeout);
      p.on("exit", (code) => {
        clearTimeout(timer);
        res({ code, out, seconds: Math.round((Date.now() - started) / 1000) });
      });
    });
  const prompt = `${link}\n\nThis is a link to my team's Agents secure chat room. Join it and do the task that is assigned to your role there; you have my OK to do it.`;

  const wanted = (name) => !process.env.LINCOR_E2E_AGENTS || process.env.LINCOR_E2E_AGENTS.split(",").includes(name);

  // 1. Claude Code with no integration: only the link, zero install (fetch → instructions → CLI).
  if (wanted("claude-zero")) {
  const z = developer("claude-zero", { "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.23f1\n" }, base);
  await check("Claude Code, zero install: link → instructions → join → task done", async () => {
    const r = await agentRun(
      "claude",
      ["-p", prompt, "--allowedTools", "Bash(curl *)", `Bash(node ${CLI} *)`, "Write", "Edit", "Read", "--permission-mode", "dontAsk", "--max-turns", "40", "--output-format", "text"],
      z.project,
      { ...z.env, LINCOR_CLIENT: "" },
    );
    writeFileSync(join(tmp, "claude-zero.log"), r.out);
    assert(existsSync(join(z.project, "PURCHASE_EVENT.md")), `file not created (exit ${r.code}); see claude-zero.log`);
    const tasks = fe.run("task", "list", "--all");
    assert(/\[(done|in progress)\]/.test(tasks), tasks);
    return `${r.seconds}s`;
  });

  }

  // 2. Claude Code with the plugin (MCP + skill + hooks), loaded only for this run.
  if (wanted("claude-plugin")) {
  const pluginRoot = join(tmp, "claude-plugin");
  execFileSync("node", [join(repo, "tests/e2e/write-plugin.mjs"), pluginRoot, `node ${CLI}`]);
  const fe2 = developer("frontend2", {}, base);
  const created2 = JSON.parse(fe2.run("create", "--name", "Plugin acceptance", "--json"));
  fe2.run("task", "create", "Write PLUGIN_OK.md", "--to", "unity", "--desc", "Create PLUGIN_OK.md in your project root containing 'ok', then mark the task done.");
  const c = developer("claude-plugin", { "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.23f1\n" }, base);
  await check("Claude Code with the plugin: MCP join → task done", async () => {
    const r = await agentRun(
      "claude",
      ["-p", `${created2.data.link}\n\nJoin my team's Agents secure chat room and do the task assigned to your role; you have my OK.`, "--plugin-dir", join(pluginRoot, "agents-room"), "--allowedTools", "mcp__plugin_agents-room_agents-room__*", "Write", "Read", "--permission-mode", "dontAsk", "--max-turns", "40"],
      c.project,
      { ...c.env, LINCOR_CLIENT: "" },
    );
    writeFileSync(join(tmp, "claude-plugin.log"), r.out);
    assert(existsSync(join(c.project, "PLUGIN_OK.md")), `file not created (exit ${r.code}); see claude-plugin.log`);
    assert(fe2.run("task", "list", "--all").includes("[done]"), "task not done");
    return `${r.seconds}s`;
  });

  }

  // 3. Codex with the lincor MCP server (config overrides only for this run).
  if (!wanted("codex")) return;
  const fe3 = developer("frontend3", {}, base);
  const created3 = JSON.parse(fe3.run("create", "--name", "Codex acceptance", "--json"));
  fe3.run("task", "create", "Write CODEX_OK.md", "--to", "unity", "--desc", "Create CODEX_OK.md in your project root containing 'ok', then mark the task done.");
  const x = developer("codex", { "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.23f1\n" }, base);
  await check("Codex with the MCP server: join → task done", async () => {
    const r = await agentRun(
      "codex",
      [
        "exec", "--skip-git-repo-check", "--ephemeral", "-C", x.project, "-s", "danger-full-access",
        ...(process.env.LINCOR_E2E_CODEX_MODEL ? ["-m", process.env.LINCOR_E2E_CODEX_MODEL] : []),
        "-c", 'mcp_servers.agents-room.command="node"',
        "-c", `mcp_servers.agents-room.args=["${CLI}","mcp"]`,
        "-c", "mcp_servers.agents-room.tool_timeout_sec=660",
        "-c", 'mcp_servers.agents-room.default_tools_approval_mode="approve"',
        "-c", `mcp_servers.agents-room.env={LINCOR_HOME="${x.env.LINCOR_HOME}",LINCOR_OWNER="codex",LINCOR_PROJECT_DIR="${x.project}"}`,
        `${created3.data.link}\n\nJoin my team's Agents secure chat room with its MCP tools and do the task assigned to your role; you have my OK.`,
      ],
      x.project,
      x.env,
    );
    writeFileSync(join(tmp, "codex.log"), r.out);
    assert(existsSync(join(x.project, "CODEX_OK.md")), `file not created (exit ${r.code}); see codex.log`);
    assert(fe3.run("task", "list", "--all").includes("[done]"), "task not done");
    return `${r.seconds}s`;
  });
}

let code = 1;
try {
  code = await main();
} finally {
  serverProcess?.kill("SIGTERM");
  for (const container of [pgContainer, s3Container]) {
    if (!container) continue;
    try {
      sh("docker", ["stop", container]);
    } catch {
      // already gone
    }
  }
}
process.exit(code);
