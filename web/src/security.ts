// /security: a live demo with the real client code. A fresh room key is made in this tab; what you type is sealed
// exactly as a room message is, and the page shows the row the server would store. Nothing is sent anywhere.
import { deriveRoom, encodeKey, newIdentity, newSecret, openEvent, sealEvent } from "@lincor/core";

const $ = (id: string) => document.getElementById(id)!;

const secret = newSecret();
const room = deriveRoom(secret);
const otherRoom = deriveRoom(newSecret()); // someone without the link (or the server) trying a key of its own
const author = newIdentity();
let seq = 0;

$("demoKey").textContent = `#${encodeKey(secret).slice(0, 18)}…`;

function render() {
  const text = ($("demoInput") as HTMLTextAreaElement).value;
  const ts = Date.now();
  const envelope = sealEvent(room, author, "message", { text }, { ts });
  seq += 1;
  const row: [string, string][] = [
    ["room_id", room.roomId],
    ["seq", String(seq)],
    ["cid", envelope.cid],
    ["sender", envelope.sender],
    ["ts", String(ts)],
    ["data", envelope.data],
  ];
  const dl = $("demoRow");
  dl.replaceChildren(
    ...row.flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      if (k === "data") dd.className = "row__data is-fresh";
      return [dt, dd];
    }),
  );
  const stored = { ...envelope, seq, ts };
  const opened = openEvent(room, stored);
  $("demoOpen").textContent = opened.ok && opened.event.type === "message" ? opened.event.body.text || "(empty message)" : "could not decrypt";
  const wrong = openEvent(otherRoom, stored);
  $("demoWrong").textContent = wrong.ok ? "decrypted (this must never happen)" : "cannot decrypt: without the key it is only ciphertext";
}

let timer: number | undefined;
$("demoInput").addEventListener("input", () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(render, 120);
});
render();

// Respect reduced motion: stop the moving tokens in the diagram.
const flow = document.querySelector<SVGSVGElement>("svg.flow");
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
const syncMotion = () => (reduce.matches ? flow?.pauseAnimations() : flow?.unpauseAnimations());
reduce.addEventListener?.("change", syncMotion);
syncMotion();
