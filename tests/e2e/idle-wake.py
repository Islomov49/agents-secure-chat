#!/usr/bin/env python3
"""Live check: does an IDLE interactive Claude Code session wake up when a lincor message arrives?

Drives a real interactive `claude` (with the lincor plugin loaded via --plugin-dir) in a pseudo-terminal:
  1. the agent's project has already joined a room (CLI, same LINCOR_HOME);
  2. the session answers one prompt and goes idle (its Stop hook arms `lincor watch --rewake`);
  3. another participant posts "@unity …" → the asyncRewake hook should wake the session, which replies;
  4. a second addressed message wakes it again (re-armed on the next Stop);
  5. a message for nobody in particular must NOT wake it.

Usage: python3 -I tests/e2e/idle-wake.py   (needs the release server and the built CLI; uses model tokens)
Everything lives in a temp dir; ~/.claude settings, ~/.codex and ~/.lincor are not touched.
"""
import json
import os
import pty
import re
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CLI = os.path.join(REPO, "packages", "cli", "dist", "agents-secure-chat.js")
SERVER = os.path.join(REPO, "server", "target", "release", "lincor-server")
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[=>()][0-9A-Za-z]?")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def stop_processes_with_env(entry):
    """Stops leftover hook watchers of the tested session: only processes carrying this exact env entry."""
    needle = entry.encode()
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            with open(f"/proc/{pid}/environ", "rb") as f:
                if needle in f.read().split(b"\0"):
                    os.kill(int(pid), signal.SIGTERM)
        except (OSError, ProcessLookupError):
            continue


def main():
    tmp = tempfile.mkdtemp(prefix="lincor-idle-wake-", dir=os.environ.get("LINCOR_E2E_TMP"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    server = subprocess.Popen(
        [SERVER],
        env={**os.environ, "LINCOR_BIND": f"127.0.0.1:{port}", "LINCOR_DATABASE_URL": f"sqlite://{tmp}/db.sqlite?mode=rwc",
             "LINCOR_BLOB_DIR": f"{tmp}/blobs", "LINCOR_CLI_COMMAND": f"node {CLI}"},
        stdout=open(f"{tmp}/server.log", "wb"), stderr=subprocess.STDOUT,
    )
    results = []
    child = None
    try:
        time.sleep(1.5)
        # Clean environment for the tested session: nothing inherited from the session running this script.
        clean = {k: v for k, v in os.environ.items() if not (k.startswith("CLAUDE") or k.startswith("LINCOR"))}

        def lincor(home, cwd, *argv, owner):
            env = {**clean, "LINCOR_HOME": home, "LINCOR_SERVER": base, "LINCOR_OWNER": owner, "LINCOR_CLIENT": "cli"}
            return subprocess.run(["node", CLI, *argv], cwd=cwd, env=env, capture_output=True, text=True, check=True).stdout

        fe_home, fe_dir = f"{tmp}/fe-lincor", f"{tmp}/fe-project"
        un_home, un_dir = f"{tmp}/unity-lincor", f"{tmp}/unity-project"
        os.makedirs(fe_dir)
        os.makedirs(f"{un_dir}/ProjectSettings")
        open(f"{un_dir}/ProjectSettings/ProjectVersion.txt", "w").write("m_EditorVersion: 6000.0.23f1\n")
        link = json.loads(lincor(fe_home, fe_dir, "create", "--name", "Idle wake", "--json", owner="ali"))["data"]["link"]
        lincor(fe_home, fe_dir, "send", "hello", owner="ali")
        lincor(un_home, un_dir, "join", link, "--role", "unity", owner="bobur")

        plugin = f"{tmp}/plugin"
        subprocess.run(["node", os.path.join(REPO, "tests/e2e/write-plugin.mjs"), plugin, f"node {CLI}"], check=True, capture_output=True)

        def messages_from_agent():
            out = lincor(fe_home, fe_dir, "read", "--all", "--limit", "200", owner="ali")
            return [line for line in out.splitlines() if "unity agent" in line and " msg " in line]

        env = {**clean, "LINCOR_HOME": un_home, "LINCOR_OWNER": "bobur", "TERM": "xterm-256color", "COLUMNS": "160", "LINES": "50"}
        argv = ["claude", "--plugin-dir", f"{plugin}/agents-secure-chat", "--allowedTools", "mcp__plugin_agents-secure-chat_agents-secure-chat__*"]
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(un_dir)
            os.execvpe(argv[0], argv, env)
        child = pid
        screen = [""]

        def pump(seconds):
            end = time.time() + seconds
            while time.time() < end:
                r, _, _ = select.select([fd], [], [], 0.2)
                if r:
                    try:
                        data = os.read(fd, 65536)
                    except OSError:
                        return
                    screen[0] += ANSI.sub("", data.decode("utf-8", "replace"))
                    screen[0] = screen[0][-200_000:]

        def type_line(text):
            os.write(fd, text.encode())
            time.sleep(0.3)
            os.write(fd, b"\r")

        pump(8)
        if re.search(r"trust\s*this\s*folder|Do\s*you\s*trust", screen[0], re.I):
            # The folder-trust dialog preselects "No, exit": move to "Yes, I trust this folder" first.
            os.write(fd, b"\x1b[B")
            time.sleep(0.5)
            os.write(fd, b"\r")
            pump(8)
        type_line("Reply with just the word READY. Do not call any tools.")
        deadline = time.time() + 120
        while time.time() < deadline and "READY" not in screen[0].split("justthewordREADY")[-1].split("just the word READY")[-1]:
            pump(1)
        if "READY" not in screen[0].split("justthewordREADY")[-1].split("just the word READY")[-1]:
            open(f"{tmp}/screen.txt", "w").write(screen[0])
            raise SystemExit(f"the interactive session did not answer READY; see {tmp}/screen.txt")
        pump(12)  # the turn ends, the Stop hook runs and the rewake watcher arms (it waits 3 s before its first check)

        def wake_test(name, text, expect_wake, marker):
            before = len(messages_from_agent())
            sent = time.time()
            lincor(fe_home, fe_dir, "send", text, owner="ali")
            woke_at = None
            limit = 120 if expect_wake else 45
            while time.time() - sent < limit:
                pump(2)
                msgs = messages_from_agent()
                if len(msgs) > before and (marker is None or any(marker in m for m in msgs[before:])):
                    woke_at = time.time() - sent
                    break
            ok = (woke_at is not None) == expect_wake
            detail = f"replied after {woke_at:.1f}s" if woke_at is not None else f"no reply within {limit}s"
            results.append({"name": name, "ok": ok, "detail": detail})
            print(f"  {'✓' if ok else '✗'} {name} — {detail}", flush=True)
            pump(12)  # let that turn end and the watcher re-arm

        print(f"idle-wake check in {tmp}", flush=True)
        wake_test("idle session wakes on '@unity …' and replies in the room", "@unity please reply in the room with the single word PONG (use chat_send).", True, "PONG")
        wake_test("it wakes again for a second message (watcher re-armed)", "@unity one more: reply in the room with PONG2.", True, "PONG2")
        wake_test("a message for nobody in particular does not wake it", "lunch anyone?", False, None)
        open(f"{tmp}/screen.txt", "w").write(screen[0])
    finally:
        if child:
            try:
                os.kill(child, signal.SIGTERM)
                time.sleep(1)
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
        stop_processes_with_env(f"LINCOR_HOME={tmp}/unity-lincor")
        server.terminate()
    passed = sum(r["ok"] for r in results)
    print(f"{passed}/{len(results)} idle-wake checks passed; transcript: {tmp}/screen.txt", flush=True)
    sys.exit(0 if passed == len(results) == 3 else 1)


if __name__ == "__main__":
    main()
