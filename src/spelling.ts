// Spelling: words Windows' spell checker doesn't know get a red wavy line.
// Words are sent to the checker once and remembered; only the paragraphs a
// change touches are looked at again. The word being typed isn't marked until
// the cursor leaves it, as in Word and OneNote.

import type { Node } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

export interface SpellChecker {
  /** For each word, whether it is spelt right. */
  check(words: string[]): Promise<boolean[]>;
  suggest(word: string): Promise<string[]>;
}

export interface Mistake {
  from: number;
  to: number;
  word: string;
}

interface SpellState {
  decorations: DecorationSet;
  /** The word being typed, left unmarked for now. */
  typing: { from: number; to: number } | null;
}

export const spellKey = new PluginKey<SpellState>("spelling");

const DICTIONARY_KEY = "ducknotes.dictionary";
const SPELLING_KEY = "ducknotes.spelling";

let checker: SpellChecker | null = null;
let showMenu: ((view: EditorView, mistake: Mistake, at: { left: number; top: number }) => void) | null = null;
/** Every word asked about so far, and whether it was right. */
const known = new Map<string, boolean>();
const pending = new Set<string>();
/** "Ignore all": for as long as the app is open. */
const ignored = new Set<string>();
const dictionary = new Set<string>(loadDictionary());
const views = new Set<EditorView>();
let enabled = readEnabled();
let timer: ReturnType<typeof setTimeout> | undefined;

function loadDictionary(): string[] {
  try {
    const words = JSON.parse(localStorage.getItem(DICTIONARY_KEY) ?? "[]");
    return Array.isArray(words) ? words.filter((w) => typeof w === "string") : [];
  } catch {
    return [];
  }
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(SPELLING_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Connects the spell checker and the menu shown on a marked word. */
export function setSpellChecker(next: SpellChecker | null, menu: typeof showMenu = null) {
  checker = next;
  showMenu = menu;
  known.clear();
  recheckAll();
}

export const spellingOn = () => enabled && !!checker;

export function setSpelling(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(SPELLING_KEY, on ? "on" : "off");
  } catch {
    // Not remembered; still switched for now.
  }
  recheckAll();
}

export function ignoreWord(word: string) {
  ignored.add(word);
  recheckAll();
}

export function addToDictionary(word: string) {
  dictionary.add(word);
  try {
    localStorage.setItem(DICTIONARY_KEY, JSON.stringify([...dictionary].sort()));
  } catch {
    // Kept until the app closes.
  }
  recheckAll();
}

export function suggestions(word: string): Promise<string[]> {
  return checker ? checker.suggest(word).catch(() => []) : Promise.resolve([]);
}

function recheckAll() {
  for (const view of views) view.dispatch(view.state.tr.setMeta(spellKey, "recheck"));
}

// Web addresses and e-mail addresses aren't words.
const ADDRESS = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|[^\s@]+@[^\s@]+\.[^\s@]+/gi;
let segmenter: Intl.Segmenter | undefined;

/** The words of a paragraph worth checking, with their places in the document. */
export function wordsOf(block: Node, blockPos: number): Mistake[] {
  let text = "";
  const positions: number[] = [];
  block.forEach((child, offset) => {
    const start = blockPos + 1 + offset;
    if (child.isText && !child.marks.some((m) => m.type.name === "deletion")) {
      for (let i = 0; i < child.text!.length; i++) positions.push(start + i);
      text += child.text;
    } else if (child.isText) {
      // Deleted text (a tracked change) isn't checked.
      for (let i = 0; i < child.text!.length; i++) positions.push(start + i);
      text += " ".repeat(child.text!.length);
    } else {
      // An equation or a field ends a word.
      positions.push(start);
      text += " ";
    }
  });
  text = text.replace(ADDRESS, (m) => " ".repeat(m.length));
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
  const out: Mistake[] = [];
  for (const seg of segmenter.segment(text)) {
    if (!seg.isWordLike) continue;
    // Apostrophes at the ends belong to the quotation, not the word.
    const word = seg.segment.replace(/^['’]+|['’]+$/g, "");
    const lead = seg.segment.indexOf(word);
    // Too short, with digits, or in capitals (an abbreviation like DNA): left alone, as in Word.
    if (word.length < 2 || /[\d_]/.test(word) || word === word.toUpperCase()) continue;
    const start = seg.index + lead;
    out.push({ word, from: positions[start], to: positions[start + word.length - 1] + 1 });
  }
  return out;
}

function isRight(word: string): boolean | undefined {
  if (ignored.has(word) || dictionary.has(word) || dictionary.has(word.toLowerCase())) return true;
  return known.get(word);
}

function ask(word: string) {
  if (known.has(word) || pending.has(word)) return;
  pending.add(word);
  clearTimeout(timer);
  timer = setTimeout(flush, 200);
}

async function flush() {
  const words = [...pending].slice(0, 2000);
  if (!words.length || !checker) return;
  const current = checker;
  let verdicts: boolean[];
  try {
    verdicts = await current.check(words);
  } catch {
    verdicts = words.map(() => true);
  }
  if (checker !== current) return;
  words.forEach((w, i) => {
    known.set(w, verdicts[i] ?? true);
    pending.delete(w);
  });
  if (pending.size) timer = setTimeout(flush, 0);
  recheckAll();
}

function blockDecorations(block: Node, pos: number, typing: SpellState["typing"]): Decoration[] {
  const out: Decoration[] = [];
  for (const w of wordsOf(block, pos)) {
    const right = isRight(w.word);
    if (right === undefined) ask(w.word);
    if (right !== false) continue;
    if (typing && w.from <= typing.to && w.to >= typing.from) continue;
    out.push(Decoration.inline(w.from, w.to, { class: "spell-error" }, { word: w.word }));
  }
  return out;
}

function decorateAll(doc: Node, typing: SpellState["typing"]): DecorationSet {
  if (!spellingOn()) return DecorationSet.empty;
  const all: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    all.push(...blockDecorations(node, pos, typing));
    return false;
  });
  return DecorationSet.create(doc, all);
}

/** Looks again at the paragraphs between `from` and `to`. */
function redecorate(set: DecorationSet, doc: Node, from: number, to: number, typing: SpellState["typing"]): DecorationSet {
  from = Math.max(0, Math.min(from, doc.content.size));
  to = Math.max(from, Math.min(to, doc.content.size));
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    set = set.remove(set.find(pos, pos + node.nodeSize)).add(doc, blockDecorations(node, pos, typing));
    return false;
  });
  return set;
}

/** The word around the cursor. */
function wordAt(state: EditorState): { from: number; to: number } | null {
  const { $head, empty } = state.selection;
  if (!empty || !$head.parent.isTextblock) return null;
  const pos = $head.pos;
  return wordsOf($head.parent, $head.before()).find((w) => w.from <= pos && w.to >= pos) ?? { from: pos, to: pos };
}

export function spellingPlugin() {
  return new Plugin<SpellState>({
    key: spellKey,
    state: {
      init: (_config, state) => ({ decorations: decorateAll(state.doc, null), typing: null }),
      apply(tr: Transaction, old, _oldState, state): SpellState {
        if (tr.getMeta(spellKey) === "recheck") return { decorations: decorateAll(state.doc, old.typing), typing: old.typing };
        if (!spellingOn()) return old.decorations === DecorationSet.empty ? old : { decorations: DecorationSet.empty, typing: null };
        if (tr.docChanged) {
          const typing = wordAt(state);
          let decorations = old.decorations.map(tr.mapping, tr.doc);
          tr.mapping.maps.forEach((map, i) => {
            const after = tr.mapping.slice(i + 1);
            map.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
              decorations = redecorate(decorations, tr.doc, after.map(newFrom, -1) - 1, after.map(newTo, 1) + 1, typing);
            });
          });
          // The word that was being typed, if the cursor has left it.
          if (old.typing && !(typing && tr.mapping.map(old.typing.from) === typing.from)) {
            const at = tr.mapping.map(old.typing.from);
            decorations = redecorate(decorations, tr.doc, at, at, typing);
          }
          return { decorations, typing };
        }
        if (old.typing && tr.selectionSet) {
          const { from, to } = state.selection;
          if (from < old.typing.from || to > old.typing.to) {
            return { decorations: redecorate(old.decorations, state.doc, old.typing.from, old.typing.to, null), typing: null };
          }
        }
        return old;
      },
    },
    view(view) {
      views.add(view);
      return { destroy: () => views.delete(view) };
    },
    props: {
      decorations: (state) => spellKey.getState(state)?.decorations,
      handleDOMEvents: {
        contextmenu(view, event) {
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
          const mistake = at && mistakeAt(view.state, at.pos);
          if (!mistake || !showMenu) return false;
          event.preventDefault();
          showMenu(view, mistake, { left: event.clientX, top: event.clientY });
          return true;
        },
      },
    },
  });
}

function toMistake(d: Decoration): Mistake {
  return { from: d.from, to: d.to, word: (d.spec as { word: string }).word };
}

export function mistakeAt(state: EditorState, pos: number): Mistake | null {
  const set = spellKey.getState(state)?.decorations;
  const found = set?.find(pos, pos).find((d) => d.from <= pos && d.to >= pos);
  return found ? toMistake(found) : null;
}

/** All the marked words, in order. */
export function mistakes(state: EditorState): Mistake[] {
  return (spellKey.getState(state)?.decorations.find() ?? []).map(toMistake).sort((a, b) => a.from - b.from);
}

/** The next marked word after the selection, wrapping round to the first. */
export function nextMistake(state: EditorState): Mistake | null {
  const all = mistakes(state);
  return all.find((m) => m.from >= state.selection.to) ?? all[0] ?? null;
}

/** Puts `replacement` in place of the word, in the word's own formatting. */
export function correct(state: EditorState, mistake: Mistake, replacement: string): Transaction | null {
  if (state.doc.textBetween(mistake.from, mistake.to) !== mistake.word) return null;
  const marks = state.doc.resolve(mistake.from + 1).marks();
  return state.tr.replaceWith(mistake.from, mistake.to, state.schema.text(replacement, marks));
}

/** Shows the menu for a marked word, as a right-click would (F7). */
export function openMenuFor(view: EditorView, mistake: Mistake) {
  if (!showMenu) return;
  const end = view.coordsAtPos(mistake.to);
  const start = view.coordsAtPos(mistake.from);
  showMenu(view, mistake, { left: start.left, top: end.bottom });
}
