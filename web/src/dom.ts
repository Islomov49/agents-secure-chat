// Small DOM helpers shared by the home and room screens.

export function $<T extends Element = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as unknown as T;
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Polite screen-reader announcement. */
export function announce(text: string): void {
  const region = document.getElementById("announcer");
  if (!region) return;
  region.textContent = "";
  // A separate task so repeated identical messages are announced again.
  setTimeout(() => {
    region.textContent = text;
  }, 30);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** Short visual notice at the bottom of the screen; also announced. */
export function toast(text: string, kind: "info" | "error" = "info"): void {
  const t = $("toast");
  t.textContent = text;
  t.dataset.kind = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, kind === "error" ? 4200 : 2400);
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Copies text and confirms on the button itself ("Link copied"), restoring its label afterwards. */
export async function copyText(text: string, button?: HTMLElement | null): Promise<void> {
  const ok = await writeClipboard(text);
  const done = ok ? (button?.dataset.done ?? "Copied") : "Copy failed: select the text and copy it";
  if (button) {
    const original = button.dataset.label ?? button.textContent ?? "";
    button.dataset.label = original;
    button.textContent = ok ? done : "Copy failed";
    button.classList.toggle("is-done", ok);
    clearTimeout(Number(button.dataset.timer));
    button.dataset.timer = String(
      setTimeout(() => {
        button.textContent = original;
        button.classList.remove("is-done");
        delete button.dataset.label;
      }, 1800),
    );
  }
  if (!ok) toast(done, "error");
  announce(done);
}

/** Saves bytes as a file through a temporary Blob URL. */
export function saveBytes(bytes: Uint8Array, name: string, mime = "application/octet-stream"): void {
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : "application/octet-stream";
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const lastHtml = new WeakMap<HTMLElement, string>();

/** Replaces a container's HTML and puts keyboard focus back on the same logical control, if it still exists. */
export function replaceHtml(container: HTMLElement, html: string): void {
  if (lastHtml.get(container) === html) return;
  const active = document.activeElement as HTMLElement | null;
  const focusKey = active && container.contains(active) ? active.dataset.focus : undefined;
  container.innerHTML = html;
  lastHtml.set(container, html);
  if (focusKey) {
    const again = container.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`);
    again?.focus({ preventScroll: true });
  }
}
