#!/usr/bin/env python3
"""Live check: paste the invite ("Copy invite") into an interactive Claude Code session and see it join and listen.

For each setup, a real interactive `claude` runs in a pseudo-terminal in a Unity-like project:
  1. the exact invite text the site and the CLI give out is pasted as the user's message;
  2. the session joins the room by itself, reports, and goes idle;
  3. another participant posts "@unity …": the idle session must wake up by itself and reply in the room;
  4. a second "@unity …" must wake it again (it keeps listening).

Setups: "zero" (nothing installed: the agent runs the CLI and must start listening in the background itself) and
"plugin" (the Claude Code plugin: MCP tools and hooks). Usage:
  python3 -I tests/e2e/invite-listen.py [zero|plugin|both]    (needs the release server and the built CLI; uses model tokens)
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
CLI = os.path.join(REPO, "packages", "cli", "dist", "agents-room.js")
SERVER = os.path.join(REPO, "server", "target", "release", "lincor-server")
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[=>()][0-9A-Za-z]?")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def stop_processes_with_env(entry):
    """Stops leftover listeners of the tested session: only processes carrying this exact env entry."""
    needle = entry.encode()
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            with open(f"/proc/{pid}/environ", "rb") as f:
                if needle in f.read().split(b"\0"):
                    os.kill(int(pid), signal.SIGTERM)
        except (OSError, ProcessLookupError):
            continue


def run_setup(mode, base, tmp, clean):
    results = []
    root = f"{tmp}/{mode}"
    fe_home, fe_dir = f"{root}/fe-lincor", f"{root}/fe-project"
    un_home, un_dir = f"{root}/unity-lincor", f"{root}/unity-project"
    os.makedirs(fe_dir)
    os.makedirs(f"{un_dir}/ProjectSettings")
    open(f"{un_dir}/ProjectSettings/ProjectVersion.txt", "w").write("m_EditorVersion: 6000.0.23f1\n")

    def lincor(*argv):
        env = {**clean, "LINCOR_HOME": fe_home, "LINCOR_SERVER": base, "LINCOR_OWNER": "ali", "LINCOR_CLIENT": "cli"}
        return subprocess.run(["node", CLI, *argv], cwd=fe_dir, env=env, capture_output=True, text=True, check=True).stdout

    created = json.loads(lincor("create", "--name", "Checkout v2", "--about", "Checkout v2: the web app and the Unity client agree on purchase events.", "--json"))["data"]
    invite = created["invite"]
    lincor("send", "Hi all, I'm on the web side. Unity, please join when you can.")

    env = {**clean, "LINCOR_HOME": un_home, "LINCOR_OWNER": "bobur", "TERM": "xterm-256color", "COLUMNS": "160", "LINES": "50"}
    if mode == "plugin":
        plugin = f"{root}/plugin"
        subprocess.run(["node", os.path.join(REPO, "tests/e2e/write-plugin.mjs"), plugin, f"node {CLI}"], check=True, capture_output=True)
        argv = ["claude", "--plugin-dir", f"{plugin}/agents-room", "--allowedTools", "mcp__plugin_agents-room_agents-room__*", "WebFetch"]
    else:
        argv = ["claude", "--allowedTools", "Bash", "WebFetch", "Read"]

    def joined():
        return "unity agent" in lincor("who")

    def messages_from_agent():
        out = lincor("read", "--all", "--limit", "200")
        return [line for line in out.splitlines() if "unity agent" in line and " msg " in line]

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(un_dir)
        os.execvpe(argv[0], argv, env)
    screen = [""]
    last_output = [time.time()]

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
                screen[0] = screen[0][-400_000:]
                last_output[0] = time.time()

    def quiet(seconds, limit):
        """Waits until the terminal has been silent for `seconds` (the turn has ended), up to `limit`."""
        end = time.time() + limit
        while time.time() < end:
            pump(1)
            if time.time() - last_output[0] >= seconds:
                return True
        return False

    def check(name, ok, detail):
        results.append({"name": f"[{mode}] {name}", "ok": ok, "detail": detail})
        print(f"  {'✓' if ok else '✗'} [{mode}] {name} — {detail}", flush=True)
        return ok

    try:
        pump(8)
        if re.search(r"trust\s*this\s*folder|Do\s*you\s*trust", screen[0], re.I):
            os.write(fd, b"\x1b[B")
            time.sleep(0.5)
            os.write(fd, b"\r")
            pump(8)
        # Paste the invite exactly as a person would (bracketed paste keeps it one message), then send it.
        os.write(fd, b"\x1b[200~" + invite.encode() + b"\x1b[201~")
        time.sleep(1)
        os.write(fd, b"\r")
        start = time.time()
        while time.time() - start < 240 and not joined():
            pump(2)
        if not check("the pasted invite makes it join the room", joined(), f"joined after {time.time() - start:.0f}s" if joined() else "did not join within 240s"):
            return results
        quiet(20, 240)  # the first turn ends: it reported and (zero install) started listening in the background
        pump(5)

        def wake(name, text, marker):
            before = len(messages_from_agent())
            sent = time.time()
            lincor("send", text)
            while time.time() - sent < 180:
                pump(2)
                msgs = messages_from_agent()
                if len(msgs) > before and any(marker in m for m in msgs[before:]):
                    check(name, True, f"replied after {time.time() - sent:.0f}s")
                    quiet(15, 180)  # let that turn end (and the listener be started again)
                    return
            check(name, False, "no reply within 180s")

        wake("the idle session wakes on '@unity …' by itself and replies", "@unity are you listening? Reply in the room with the single word PONG.", "PONG")
        wake("it keeps listening: a second message wakes it again", "@unity one more: reply in the room with PONG2.", "PONG2")
    finally:
        open(f"{root}/screen.txt", "w").write(screen[0])
        try:
            os.kill(pid, signal.SIGTERM)
            time.sleep(1)
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        stop_processes_with_env(f"LINCOR_HOME={un_home}")
    return results


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    modes = ["zero", "plugin"] if which == "both" else [which]
    tmp = tempfile.mkdtemp(prefix="lincor-invite-listen-", dir=os.environ.get("LINCOR_E2E_TMP"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    server = subprocess.Popen(
        [SERVER],
        env={**os.environ, "LINCOR_BIND": f"127.0.0.1:{port}", "LINCOR_DATABASE_URL": f"sqlite://{tmp}/db.sqlite?mode=rwc",
             "LINCOR_BLOB_DIR": f"{tmp}/blobs", "LINCOR_CLI_COMMAND": f"node {CLI}", "LINCOR_PUBLIC_URL": base},
        stdout=open(f"{tmp}/server.log", "wb"), stderr=subprocess.STDOUT,
    )
    results = []
    try:
        time.sleep(1.5)
        # A clean environment for the tested sessions: nothing inherited from the session running this script.
        clean = {k: v for k, v in os.environ.items() if not (k.startswith("CLAUDE") or k.startswith("LINCOR") or k.startswith("npm_"))}
        print(f"invite-listen check in {tmp}", flush=True)
        for mode in modes:
            results += run_setup(mode, base, tmp, clean)
    finally:
        server.terminate()
    passed = sum(r["ok"] for r in results)
    expected = 3 * len(modes)
    print(f"{passed}/{expected} invite-listen checks passed; transcripts: {tmp}/<setup>/screen.txt", flush=True)
    sys.exit(0 if passed == len(results) == expected else 1)


if __name__ == "__main__":
    main()
