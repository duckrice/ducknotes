// Flashcards from notes: each line tagged Question (Ctrl+3) is a card, and the lines under it,
// up to the next tagged line or heading, are its answer. A question with nothing under it is
// split at its question mark ("What is ATP? The cell's fuel"), or has no answer to show.

import { h } from "./dom";
import type { PageItem } from "./store";
import { modal } from "./ui";

export interface Card {
  front: string;
  back: string;
  /** The page it's from, to say where. */
  page: string;
}

interface DocNode {
  type?: string;
  text?: string;
  attrs?: { tag?: string | null; latex?: string };
  content?: DocNode[];
}

const textOf = (node: DocNode): string => (node.text ?? "") + (node.attrs?.latex ? ` ${node.attrs.latex} ` : "") + (node.content ?? []).map(textOf).join(node.type === "bullet_list" || node.type === "ordered_list" ? "\n" : "");

/** The cards on a page. */
export function cardsOf(title: string, items: PageItem[]): Card[] {
  const cards: Card[] = [];
  for (const item of items) {
    if (item.t !== "box" || !item.doc || typeof item.doc !== "object") continue;
    const blocks = (item.doc as DocNode).content ?? [];
    blocks.forEach((block, i) => {
      if (block.attrs?.tag !== "question") return;
      const answer: string[] = [];
      for (const next of blocks.slice(i + 1)) {
        if (next.attrs?.tag || next.type === "heading") break;
        const words = textOf(next).trim();
        if (words) answer.push(words);
      }
      let front = textOf(block).trim();
      let back = answer.join("\n");
      const mark = front.indexOf("?");
      if (!back && mark >= 0 && mark < front.length - 1) [front, back] = [front.slice(0, mark + 1), front.slice(mark + 1).trim()];
      if (front) cards.push({ front, back, page: title || "Untitled page" });
    });
  }
  return cards;
}

/** Goes through the cards in a random order; the ones not known come back at the end. */
export function practise(cards: Card[]) {
  const queue = [...cards].sort(() => Math.random() - 0.5);
  const total = queue.length;
  let knew = 0;
  let firstTry = true;
  const missed = new Set<Card>();
  const front = h("div", { class: "card-front" });
  const back = h("div", { class: "card-back" });
  const where = h("div", { class: "card-where" });
  const progress = h("div", { class: "card-progress" });
  const show = h("button", { type: "button", class: "btn primary" }, "Show answer (Space)");
  const no = h("button", { type: "button", class: "btn" }, "Didn't know (1)");
  const yes = h("button", { type: "button", class: "btn primary" }, "Knew it (2)");
  const done = h("button", { type: "button", class: "btn" }, "Close");
  const buttons = h("div", { class: "dialog-buttons" });
  const close = modal(h("div", { class: "dialog flashcards", role: "dialog", "aria-label": "Practise" }, h("h2", {}, "Practise"), progress, front, back, where, buttons), (event) => {
    if (event.key === "Escape") close();
    else if (event.key === " " && !show.hidden && buttons.contains(show)) (event.preventDefault(), reveal());
    else if (event.key === "1" && buttons.contains(no)) answer(false);
    else if (event.key === "2" && buttons.contains(yes)) answer(true);
  });
  const next = () => {
    const card = queue[0];
    if (!card) {
      front.textContent = `Done: you knew ${knew} of ${total} the first time.`;
      back.textContent = missed.size ? `Worth another look: ${[...missed].map((c) => c.front).join(" · ")}` : "";
      back.hidden = !missed.size;
      where.textContent = "";
      progress.textContent = "";
      buttons.replaceChildren(done);
      done.focus();
      return;
    }
    firstTry = !missed.has(card);
    front.textContent = card.front;
    back.textContent = card.back || "(No answer written under this question.)";
    back.hidden = true;
    where.textContent = card.page;
    const unseen = queue.filter((c) => !missed.has(c)).length;
    progress.textContent = firstTry ? `${total - unseen + 1} of ${total}` : `Once more: ${queue.length} left`;
    buttons.replaceChildren(show);
    show.focus();
  };
  const reveal = () => {
    back.hidden = false;
    buttons.replaceChildren(no, yes);
    yes.focus();
  };
  const answer = (known: boolean) => {
    const card = queue.shift()!;
    if (known && firstTry) knew++;
    if (!known) {
      missed.add(card);
      queue.push(card);
    }
    next();
  };
  show.addEventListener("click", reveal);
  no.addEventListener("click", () => answer(false));
  yes.addEventListener("click", () => answer(true));
  done.addEventListener("click", () => close());
  next();
}
