// @mention suggestions under the composer: typing @ lists who a handle would address (PROTOCOL §5.5); arrows move,
// Enter or Tab inserts, Escape closes. The list is a listbox the textarea points at with aria-activedescendant.
import { announce } from "./dom";
import { escapeHtml as esc, insertMention, mentionQuery, type MentionOption } from "./view";

export class MentionPicker {
  private options: MentionOption[] = [];
  private active = 0;
  private start = 0;
  private query = "";
  private open = false;

  constructor(
    private readonly input: HTMLTextAreaElement,
    private readonly list: HTMLElement,
    private readonly optionsFor: (query: string) => MentionOption[],
  ) {
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", list.id);
    // mousedown, not click: the textarea keeps focus and its caret.
    list.addEventListener("mousedown", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
      if (!item) return;
      e.preventDefault();
      this.pick(Number(item.dataset.index));
    });
    input.addEventListener("blur", () => this.close());
  }

  /** Re-reads the text at the caret; call after input and caret moves. */
  update(): void {
    const found = this.input.selectionStart === this.input.selectionEnd ? mentionQuery(this.input.value, this.input.selectionStart) : null;
    const options = found ? this.optionsFor(found.query) : [];
    if (!found || !options.length) return this.close();
    const keep = this.open && found.start === this.start ? this.options[this.active]?.handle : undefined;
    this.start = found.start;
    this.query = found.query.toLowerCase();
    this.options = options;
    this.active = Math.max(0, keep ? options.findIndex((o) => o.handle === keep) : 0);
    if (!this.open) announce(`${options.length} ${options.length === 1 ? "suggestion" : "suggestions"}, arrows to choose, Enter to insert`);
    this.open = true;
    this.render();
  }

  /** Handles a keydown in the composer; true when the picker used the key. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.open || e.isComposing) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const n = this.options.length;
      this.active = (this.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      this.render();
    } else if (e.key === "Enter" && !e.shiftKey && this.options[this.active]?.handle === this.query) {
      // The handle is typed out already: Enter sends, as it would without the list.
      this.close();
      return false;
    } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      this.pick(this.active);
    } else if (e.key === "Escape") {
      this.close();
    } else return false;
    e.preventDefault();
    return true;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.options = [];
    this.list.hidden = true;
    this.list.innerHTML = "";
    this.input.removeAttribute("aria-activedescendant");
  }

  private pick(index: number) {
    const option = this.options[index];
    if (!option) return;
    const next = insertMention(this.input.value, this.start, this.input.selectionStart, option.handle);
    this.input.value = next.text;
    this.input.setSelectionRange(next.caret, next.caret);
    this.close();
    this.input.dispatchEvent(new Event("input", { bubbles: true }));
    announce(`@${option.handle} inserted`);
  }

  private render() {
    this.list.innerHTML = this.options
      .map((o, i) => {
        const mark =
          o.kind === "person"
            ? `<span class="avatar${o.human ? " avatar--human" : ""}" aria-hidden="true">${esc(o.initial)}</span>`
            : `<span class="mention-opt__mark" aria-hidden="true">${o.kind === "all" ? "*" : "#"}</span>`;
        return `<li class="mention-opt" role="option" id="mention-opt-${i}" data-index="${i}" aria-selected="${i === this.active}">
          ${mark}<span class="mention-opt__main"><span class="mention-opt__label">${esc(o.label)}</span><span class="mention-opt__handle">@${esc(o.handle)}</span></span>
          <span class="mention-opt__detail">${esc(o.detail)}</span></li>`;
      })
      .join("");
    this.list.hidden = false;
    this.input.setAttribute("aria-activedescendant", `mention-opt-${this.active}`);
    this.list.querySelector(`#mention-opt-${this.active}`)?.scrollIntoView({ block: "nearest" });
  }
}
