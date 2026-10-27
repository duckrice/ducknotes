// The menu on a word with a red line: Windows' suggestions, Ignore all, Add to
// dictionary. Opened by right-clicking the word.

import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { h } from "./dom";
import { addToDictionary, correct, ignoreWord, suggestions, type Mistake } from "./spelling";

let open: { el: HTMLElement; close: () => void } | null = null;

export function closeSpellMenu() {
  open?.close();
}

export function showSpellMenu(view: EditorView, mistake: Mistake, at: { left: number; top: number }) {
  closeSpellMenu();
  // The word is selected, so it's clear which one the menu is about.
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, mistake.from, mistake.to)));
  const el = h("div", { class: "menu spell-menu", role: "menu" }, h("div", { class: "spell-loading" }, "Looking for suggestions…"));
  document.body.append(el);
  place(el, at);

  const close = (refocus = true) => {
    if (open?.el !== el) return;
    open = null;
    el.remove();
    document.removeEventListener("mousedown", outside, true);
    if (refocus) view.focus();
  };
  const outside = (event: MouseEvent) => {
    if (!el.contains(event.target as Node)) close(false);
  };
  document.addEventListener("mousedown", outside, true);
  open = { el, close: () => close(false) };

  const item = (label: string, run: () => void, cls = "menu-item") => {
    const b = h("button", { type: "button", class: cls, role: "menuitem" }, label);
    b.addEventListener("mousedown", (event) => event.preventDefault());
    b.addEventListener("click", () => {
      close();
      run();
    });
    return b;
  };

  void suggestions(mistake.word).then((words) => {
    if (open?.el !== el) return;
    el.replaceChildren(
      ...(words.length
        ? words.map((w) =>
            item(
              w,
              () => {
                const tr = correct(view.state, mistake, w);
                if (tr) view.dispatch(tr.scrollIntoView());
              },
              "menu-item spell-suggestion",
            ),
          )
        : [h("div", { class: "spell-loading" }, "No suggestions")]),
      h("div", { class: "menu-separator" }),
      item("Ignore all", () => ignoreWord(mistake.word)),
      item("Add to dictionary", () => addToDictionary(mistake.word)),
    );
    place(el, at);
    (el.querySelector(".menu-item") as HTMLElement | null)?.focus();
  });

  el.addEventListener("keydown", (event) => {
    const items = [...el.querySelectorAll<HTMLElement>(".menu-item")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = (i + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      items[i]?.click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  });
}

/** Below the point, kept inside the window. */
function place(el: HTMLElement, at: { left: number; top: number }) {
  el.style.position = "fixed";
  el.style.zIndex = "60";
  const { width, height } = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(at.left, window.innerWidth - width - 8));
  const top = at.top + height + 8 > window.innerHeight ? Math.max(8, at.top - height - 24) : at.top + 4;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}
