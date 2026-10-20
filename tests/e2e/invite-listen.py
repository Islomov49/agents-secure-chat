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
  LINCOR_E2E_URL=https://agents-room.cc python3 -I tests/e2e/invite-listen.py zero
      against a deployed server: the agent follows that server's instructions (its published npm CLI)
Everything lives in a temp dir; ~/.claude settings, ~/.codex and ~/.lincor are not touched: the sessions skip user
settings (so a plugin installed on this machine plays no part), and the integration installer, which the invite
allows the agent to run, gets a stand-in `claude` (LINCOR_CLAUDE_BIN) that only records what it was asked to do.
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
        if not os.environ.get("LINCOR_E2E_URL"):
            env["LINCOR_CLI_COMMAND"] = f"node {CLI}"  # the invite's setup command runs the local build
        return subprocess.run(["node", CLI, *argv], cwd=fe_dir, env=env, capture_output=True, text=True, check=True).stdout

    created = json.loads(lincor("create", "--name", "Checkout v2", "--about", "Checkout v2: the web app and the Unity client agree on purchase events.", "--json"))["data"]
    invite = created["invite"]
    lincor("send", "Hi all, I'm on the web side. Unity, please join when you can.")

    fake_claude = f"{root}/fake-claude"
    install_log = f"{root}/install-calls.txt"
    with open(fake_claude, "w") as f:
        f.write(f"#!/bin/sh\necho \"$@\" >> '{install_log}'\n")
    os.chmod(fake_claude, 0o755)
    env = {**clean, "LINCOR_HOME": un_home, "LINCOR_OWNER": "bobur", "LINCOR_CLAUDE_BIN": fake_claude, "CODEX_HOME": f"{root}/codex-home",
           "TERM": "xterm-256color", "COLUMNS": "160", "LINES": "50"}
    claude = subprocess.run(["sh", "-c", "command -v claude"], capture_output=True, text=True).stdout.strip() or "claude"
    no_user_settings = ["--setting-sources", "project,local"]
    if mode == "plugin":
        plugin = f"{root}/plugin"
        subprocess.run(["node", os.path.join(REPO, "tests/e2e/write-plugin.mjs"), plugin, f"node {CLI}"], check=True, capture_output=True)
        argv = [claude, *no_user_settings, "--plugin-dir", f"{plugin}/agents-room", "--allowedTools", "mcp__plugin_agents-room_agents-room__*", "WebFetch", "Bash"]
    else:
        argv = [claude, *no_user_settings, "--strict-mcp-config", "--allowedTools", "Bash", "WebFetch", "Read"]

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
            if time.time() - last_output[0] > 25 and time.time() - start > 40:
                break  # the first turn ended without joining
        if not joined():
            # Permissions blocked the setup command. The invite tells the agent to hand it to the user instead of
            # working around it; do what a person would: run the command it gave with `!`, then say done.
            flat = re.sub(r"\s+", "", screen[0])
            setup_cmd = next(line for line in invite.splitlines() if " setup '" in line)
            handed = "!" in flat and re.sub(r"\s+", "", setup_cmd)[:40] in flat
            check("blocked by permissions, it hands the user the exact command instead of working around it", handed, "it gave the ! command" if handed else "no command for the user")
            if not handed:
                return results
            os.write(fd, b"\x1b")  # close a "Teach auto mode" dialog if one is open
            pump(2)
            os.write(fd, b"!")
            time.sleep(0.5)
            os.write(fd, setup_cmd.encode())
            time.sleep(0.5)
            os.write(fd, b"\r")
            ran = time.time()
            while time.time() - ran < 120 and not joined():
                pump(2)
            quiet(5, 30)
            os.write(fd, b"done, carry on")
            time.sleep(0.5)
            os.write(fd, b"\r")
        if not check("the pasted invite makes it join the room", joined(), f"joined after {time.time() - start:.0f}s" if joined() else f"did not join; who: {lincor('who').strip()!r}"):
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
        print(f"  the room as the web side sees it:\n    " + "\n    ".join(lincor("read", "--all", "--limit", "20").splitlines()[-6:]), flush=True)
        calls = open(install_log).read().strip() if os.path.exists(install_log) else ""
        print(f"  integration install the agent ran (stand-in claude): {calls.replace(chr(10), ' | ') or 'none'}", flush=True)
    finally:
        try:
            lincor("delete-room", "--yes")
        except subprocess.CalledProcessError:
            pass
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
    external = os.environ.get("LINCOR_E2E_URL", "").rstrip("/")
    server = None
    if external:
        base = external
    else:
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
        if server:
            server.terminate()
    passed = sum(r["ok"] for r in results)
    expected = len(results) if all(r["ok"] for r in results) and len(results) >= 3 * len(modes) else 3 * len(modes)
    print(f"{passed}/{len(results)} invite-listen checks passed; transcripts: {tmp}/<setup>/screen.txt", flush=True)
    sys.exit(0 if passed == len(results) and len(results) >= 3 * len(modes) else 1)


if __name__ == "__main__":
    main()
