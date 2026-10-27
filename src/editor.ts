// The page editor: a ProseMirror view with what quick note-taking needs.
// Markdown-style shortcuts while typing (# heading, - list, [] checkbox,
// $x^2$ equation, -> arrow), OneNote's keys, tables, pictures and equations.

import { baseKeymap, chainCommands, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { MarkType, Node, NodeType } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState, NodeSelection, Plugin, PluginKey, TextSelection, type Command } from "prosemirror-state";
import { addRowAfter, columnResizing, goToNextCell, isInTable, tableEditing } from "prosemirror-tables";
import { findWrapping } from "prosemirror-transform";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { editEquation, insertEquation } from "./equation";
import { ImageView } from "./imageview";
import { MathView } from "./mathview";
import { schema } from "./schema";
import { spellingPlugin } from "./spelling";
import { openUrl } from "./store";

const n = schema.nodes;
const m = schema.marks;

// ---- commands -----------------------------------------------------------------

/** The list item the cursor is in, and where it starts. */
function listItemAt(state: EditorState): { node: Node; pos: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === n.list_item) return { node: $from.node(d), pos: $from.before(d) };
  return null;
}

/** Enter in a checklist starts another unticked box. */
const splitItem: Command = (state, dispatch) => {
  const item = listItemAt(state);
  return splitListItem(n.list_item, item && item.node.attrs.checked !== null ? { checked: false } : undefined)(state, dispatch);
};

/** Turns lines into a list of the given kind, or back into plain lines if they already are one. */
export function toggleList(kind: "bullet" | "number" | "check"): Command {
  return (state, dispatch) => {
    const item = listItemAt(state);
    const listType = kind === "number" ? n.ordered_list : n.bullet_list;
    if (item) {
      const $pos = state.doc.resolve(item.pos);
      const list = $pos.parent;
      const isCheck = item.node.attrs.checked !== null;
      const same = list.type === listType && (kind === "check") === isCheck;
      if (same) return liftListItem(n.list_item)(state, dispatch);
      // Change the kind of the whole list in place.
      if (dispatch) {
        const tr = state.tr;
        const listPos = $pos.before();
        if (list.type !== listType) tr.setNodeMarkup(listPos, listType);
        list.forEach((child, offset) => {
          tr.setNodeMarkup(listPos + 1 + offset, undefined, { ...child.attrs, checked: kind === "check" ? (child.attrs.checked ?? false) : null });
        });
        dispatch(tr);
      }
      return true;
    }
    if (kind !== "check") return wrapInList(listType)(state, dispatch);
    return wrapInChecklist(state, dispatch);
  };
}

const wrapInChecklist: Command = (state, dispatch) =>
  wrapInList(n.bullet_list)(
    state,
    dispatch &&
      ((tr) => {
        // Every item of the new list gets a box.
        const { $from } = tr.selection;
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type !== n.bullet_list) continue;
          const start = $from.before(d);
          $from.node(d).forEach((child, offset) => tr.setNodeMarkup(start + 1 + offset, undefined, { ...child.attrs, checked: false }));
          break;
        }
        dispatch(tr);
      }),
  );

/** Ticks or unticks the box of the checklist item at the cursor. */
export const toggleCheck: Command = (state, dispatch) => {
  const item = listItemAt(state);
  if (!item || item.node.attrs.checked === null) return toggleList("check")(state, dispatch);
  if (dispatch) dispatch(state.tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: !item.node.attrs.checked }));
  return true;
};

export const TAGS = ["important", "question", "exam"] as const;
export type Tag = (typeof TAGS)[number];

/** Tags the lines in the selection (the same tag again takes it off), as OneNote's Ctrl+2 and Ctrl+3. */
export function toggleTag(tag: Tag): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const lines: { pos: number; node: import("prosemirror-model").Node }[] = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === n.paragraph) lines.push({ pos, node });
    });
    if (!lines.length) return false;
    const off = lines.every((l) => l.node.attrs.tag === tag);
    if (dispatch) {
      const tr = state.tr;
      for (const { pos, node } of lines) tr.setNodeMarkup(pos, undefined, { ...node.attrs, tag: off ? null : tag });
      dispatch(tr);
    }
    return true;
  };
}

/** The tag of the line at the cursor. */
export function tagAt(state: import("prosemirror-state").EditorState): string | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === n.paragraph) return $from.node(d).attrs.tag;
  return null;
}

export function setHeading(level: number): Command {
  return level ? setBlockType(n.heading, { level }) : setBlockType(n.paragraph);
}

/** Applies a mark with a colour; the same colour again takes it off. */
export function toggleColor(type: MarkType, color: string | null): Command {
  return (state, dispatch) => {
    const { from, to, empty, $from } = state.selection;
    const current = empty ? type.isInSet(state.storedMarks ?? $from.marks()) : state.doc.rangeHasMark(from, to, type) ? type : null;
    const same = current && "attrs" in current && current.attrs.color === color;
    if (!dispatch) return true;
    const tr = state.tr;
    if (empty) {
      tr.removeStoredMark(type);
      if (color && !same) tr.addStoredMark(type.create({ color }));
    } else {
      tr.removeMark(from, to, type);
      if (color && !same) tr.addMark(from, to, type.create({ color }));
    }
    dispatch(tr);
    return true;
  };
}

export function insertBlock(node: Node): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const tr = state.tr.replaceSelectionWith(node);
    // Somewhere to keep writing after it.
    if (!tr.selection.$from.parent.isTextblock) {
      const at = tr.selection instanceof NodeSelection ? tr.selection.to : tr.selection.from;
      tr.insert(at, n.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, at + 1));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** A table with a heading row, the cursor in its first cell. */
export function insertTable(rows: number, cols: number): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const row = (r: number) => n.table_row.create(null, Array.from({ length: cols }, () => (r ? n.table_cell : n.table_header).createAndFill()!));
    const table = n.table.create(null, Array.from({ length: rows }, (_, r) => row(r)));
    const start = state.selection.from;
    insertBlock(table)(state, (tr) => {
      let first = -1;
      tr.doc.nodesBetween(Math.max(0, tr.mapping.map(start, -1) - 2), tr.doc.content.size, (node, pos) => {
        if (first < 0 && node.type === n.table_header) first = pos;
        return first < 0;
      });
      if (first >= 0) tr.setSelection(TextSelection.near(tr.doc.resolve(first + 1)));
      dispatch(tr);
    });
    return true;
  };
}

/** The usual text size, in pixels, and the steps Alt+scroll wheel goes through. */
export const TEXT_SIZE = 15;
const SIZES = [8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96];

/** The size of the text at the cursor, or at the start of the selection. */
export function sizeAt(state: EditorState): number {
  const { $from, empty } = state.selection;
  const marks = empty ? (state.storedMarks ?? $from.marks()) : ($from.nodeAfter?.marks ?? $from.marks());
  const mark = m.size.isInSet(marks);
  if (mark) return mark.attrs.px;
  const parent = $from.parent;
  return parent.type === n.heading ? [0, 24, 20, 17][parent.attrs.level] : TEXT_SIZE;
}

/** Makes the text a step bigger (1) or smaller (-1). */
export function stepSize(direction: 1 | -1): Command {
  return (state, dispatch) => {
    const now = sizeAt(state);
    const next = direction > 0 ? SIZES.find((s) => s > now) : [...SIZES].reverse().find((s) => s < now);
    if (!next) return false;
    if (dispatch) {
      const { from, to, empty } = state.selection;
      const mark = m.size.create({ px: next });
      dispatch(empty ? state.tr.addStoredMark(mark) : state.tr.removeMark(from, to, m.size).addMark(from, to, mark));
    }
    return true;
  };
}

/** Today's date or the time, as OneNote's Alt+Shift+D and Alt+Shift+T put them in. */
export function insertStamp(kind: "date" | "time"): Command {
  return (state, dispatch) => {
    const now = new Date();
    const text = kind === "date" ? now.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    if (dispatch) dispatch(state.tr.insertText(text).scrollIntoView());
    return true;
  };
}

/** Adds a link to the selected words, or changes or removes the one at the cursor. */
export function setLink(href: string | null): Command {
  return (state, dispatch) => {
    let { from, to } = state.selection;
    if (state.selection.empty) {
      // The whole link the cursor is in.
      const $pos = state.selection.$from;
      const link = m.link.isInSet($pos.marks());
      if (!link && !href) return false;
      if (link) {
        let start = $pos.pos - $pos.textOffset;
        let end = start + ($pos.parent.maybeChild($pos.index())?.nodeSize ?? 0);
        $pos.parent.forEach((child, offset) => {
          const at = $pos.start() + offset;
          if (link.isInSet(child.marks) && at <= $pos.pos && at + child.nodeSize >= $pos.pos) {
            start = Math.min(start, at);
            end = Math.max(end, at + child.nodeSize);
          }
        });
        from = start;
        to = end;
      }
    }
    if (!dispatch) return true;
    const tr = state.tr;
    if (from === to && href) tr.insertText(href, from).addMark(from, from + href.length, m.link.create({ href }));
    else {
      tr.removeMark(from, to, m.link);
      if (href) tr.addMark(from, to, m.link.create({ href }));
    }
    dispatch(tr);
    return true;
  };
}

/** Adds http:// to a bare address, so "duck.no" works. */
export function normaliseUrl(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  if (/^(https?:\/\/|mailto:)/i.test(value)) return value;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `mailto:${value}`;
  return `https://${value}`;
}

// ---- typing shortcuts -------------------------------------------------------

function rules() {
  const replace = (pattern: RegExp, text: string) => new InputRule(pattern, text);
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,3})\s$/, n.heading, (match) => ({ level: match[1].length })),
      textblockTypeInputRule(/^```$/, n.code_block),
      wrappingInputRule(/^\s*>\s$/, n.blockquote),
      wrappingInputRule(/^\s*([-+*•])\s$/, n.bullet_list),
      wrappingInputRule(/^(\d+)[.)]\s$/, n.ordered_list, (match) => ({ order: Number(match[1]) }), (match, node) => node.childCount + node.attrs.order === Number(match[1])),
      // [] or [x] starts a checklist.
      new InputRule(/^\s*\[([ xX]?)\]\s$/, (state, match, start, end) => {
        const checked = !!match[1].trim();
        // Already in a list: this item gets a box, ticked or not.
        const item = listItemAt(state);
        if (item) return state.tr.delete(start, end).setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked });
        const tr = state.tr.delete(start, end);
        const range = tr.doc.resolve(start).blockRange();
        const wrapping = range && findWrapping(range, n.bullet_list);
        if (!range || !wrapping) return null;
        return tr.wrap(range, wrapping.map((w) => (w.type === n.list_item ? { type: w.type, attrs: { checked } } : w)));
      }),
      new InputRule(/^(?:---|___|\*\*\*)$/, (state, _match, start, end) => {
        const $start = state.doc.resolve(start);
        if ($start.parent.type !== n.paragraph || $start.depth !== 1) return null;
        const at = $start.before();
        const tr = state.tr.delete(start, end);
        tr.replaceWith(at, at + 2, [n.horizontal_rule.create(), n.paragraph.create()]);
        return tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView();
      }),
      // $x^2$ becomes an equation.
      new InputRule(/(?:^|[^$\\])\$([^$\s](?:[^$]*[^$\s])?)\$$/, (state, match, start, end) => {
        const offset = match[0].indexOf("$");
        return state.tr.replaceWith(start + offset, end, n.math.create({ latex: match[1] }));
      }),
      // Typed web addresses become links.
      new InputRule(/(?:^|\s)((?:https?:\/\/|www\.)[^\s]+[^\s.,;:!?)])\s$/, (state, match, _start, end) => {
        const url = match[1];
        const from = end - url.length;
        if (state.doc.rangeHasMark(from, end, m.link)) return null;
        return state.tr.addMark(from, from + url.length, m.link.create({ href: normaliseUrl(url) })).insertText(" ", end);
      }),
      replace(/->$/, "→"),
      replace(/<-$/, "←"),
      replace(/←>$/, "↔"),
      replace(/=>$/, "⇒"),
      replace(/<=$/, "≤"),
      replace(/≤>$/, "⇔"),
      replace(/>=$/, "≥"),
      replace(/!=$/, "≠"),
      replace(/\+-$/, "±"),
    ],
  });
}

// ---- small plugins ----------------------------------------------------------

/** Clicking a checklist box ticks it; Ctrl+click on a link opens it. */
const clicks = new Plugin({
  props: {
    handleDOMEvents: {
      mousedown(view, event) {
        const li = (event.target as HTMLElement).closest?.("li.task");
        if (!li || event.button !== 0) return false;
        // Only the box, which sits to the left of the words.
        const words = li.firstElementChild?.getBoundingClientRect();
        if (!words || event.clientX >= words.left) return false;
        const pos = view.posAtDOM(li, 0) - 1;
        const node = view.state.doc.nodeAt(pos);
        if (node?.type !== n.list_item) return false;
        event.preventDefault();
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
        return true;
      },
      click(_view, event) {
        const a = (event.target as HTMLElement).closest?.("a[href]");
        if (!a) return false;
        event.preventDefault();
        if (!(event.ctrlKey || event.metaKey)) return false;
        void openUrl(a.getAttribute("href")!).catch((error) => console.warn("Could not open the link", error));
        return true;
      },
    },
  },
});

/** Grey words on an empty page saying how to start. */
const placeholder = new Plugin({
  props: {
    decorations(state) {
      const doc = state.doc;
      if (doc.childCount !== 1 || doc.firstChild!.type !== n.paragraph || doc.firstChild!.content.size) return null;
      return DecorationSet.create(doc, [Decoration.node(0, doc.firstChild!.nodeSize, { class: "placeholder", "data-placeholder": "Type here: # heading, - list, [] checkbox, $x^2$ equation" })]);
    },
  },
});

export const searchKey = new PluginKey<string>("search");

/** Marks every place the searched-for words appear. */
const searchHighlight = new Plugin<string>({
  key: searchKey,
  state: {
    init: () => "",
    apply: (tr, value) => tr.getMeta(searchKey) ?? value,
  },
  props: {
    decorations(state) {
      const query = searchKey.getState(state)?.toLowerCase();
      if (!query) return null;
      const found: Decoration[] = [];
      state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        const text = node.text!.toLowerCase();
        for (let i = text.indexOf(query); i >= 0; i = text.indexOf(query, i + query.length)) found.push(Decoration.inline(pos + i, pos + i + query.length, { class: "search-hit" }));
      });
      return DecorationSet.create(state.doc, found);
    },
  },
});

// ---- the editor -------------------------------------------------------------

/** Tab in a table moves to the next cell; in the last one it adds a row. */
const nextCellOrRow: Command = (state, dispatch, view) => {
  if (goToNextCell(1)(state, dispatch)) return true;
  if (!isInTable(state)) return false;
  if (!dispatch || !view) return true;
  addRowAfter(state, dispatch);
  goToNextCell(1)(view.state, view.dispatch);
  return true;
};

export function createState(doc: Node): EditorState {
  const mark = (type: MarkType) => toggleMark(type);
  return EditorState.create({
    doc,
    plugins: [
      rules(),
      history(),
      spellingPlugin(),
      keymap({
        "Mod-z": undo,
        "Mod-y": redo,
        "Shift-Mod-z": redo,
        "Mod-b": mark(m.bold),
        "Mod-i": mark(m.italic),
        "Mod-u": mark(m.underline),
        "Mod--": mark(m.strike),
        "Mod-Shift-x": mark(m.strike),
        "Mod-`": mark(m.code),
        "Mod-Shift-h": toggleColor(m.highlight, "#fde68a"),
        // OneNote's keys for lists and checkboxes.
        "Mod-.": toggleList("bullet"),
        "Mod-/": toggleList("number"),
        "Mod-1": toggleCheck,
        "Mod-2": toggleTag("important"),
        "Mod-3": toggleTag("question"),
        "Mod-4": toggleTag("exam"),
        "Mod-Shift-1": setHeading(1),
        "Mod-Shift-2": setHeading(2),
        "Mod-Shift-3": setHeading(3),
        "Mod-0": setHeading(0),
        "Mod-Shift-.": wrapIn(n.blockquote),
        "Alt-=": (_state, _dispatch, view) => {
          if (view) insertEquation(view);
          return true;
        },
        "Alt-Shift-d": insertStamp("date"),
        "Alt-Shift-t": insertStamp("time"),
        "Mod-]": stepSize(1),
        "Mod-[": stepSize(-1),
        "Shift-Enter": (state, dispatch) => {
          if (dispatch) dispatch(state.tr.replaceSelectionWith(n.hard_break.create()).scrollIntoView());
          return true;
        },
        Enter: splitItem,
        Tab: chainCommands(nextCellOrRow, sinkListItem(n.list_item), (state, dispatch) => {
          if (dispatch) dispatch(state.tr.insertText("\t"));
          return true;
        }),
        "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(n.list_item), () => true),
      }),
      keymap(baseKeymap),
      columnResizing({ cellMinWidth: 40 }),
      tableEditing(),
      clicks,
      placeholder,
      searchHighlight,
      dropCursor({ color: "#0f766e", width: 2 }),
      gapCursor(),
    ],
  });
}

export interface EditorHooks {
  onChange(view: EditorView, docChanged: boolean): void;
  /** Picture files pasted or dropped onto the page. */
  onPictures(files: File[], view: EditorView, pos: number | null): void;
}

export function createView(host: HTMLElement, state: EditorState, hooks: EditorHooks): EditorView {
  const pictures = (list: FileList | undefined | null) => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
  const view: EditorView = new EditorView(host, {
    state,
    attributes: { class: "note", spellcheck: "false" },
    nodeViews: {
      math: (node, v, getPos) => new MathView(node, v, getPos, (pos) => editEquation(v, pos)),
      image: (node, v, getPos) => new ImageView(node, v, getPos),
    },
    handlePaste(v, event) {
      const files = pictures(event.clipboardData?.files);
      if (!files.length) return false;
      hooks.onPictures(files, v, null);
      return true;
    },
    handleDrop(v, event) {
      const files = pictures(event.dataTransfer?.files);
      if (!files.length) return false;
      event.preventDefault();
      hooks.onPictures(files, v, v.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null);
      return true;
    },
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
      hooks.onChange(view, tr.docChanged);
    },
  });
  return view;
}

/** Puts pictures (already stored) into the page at `pos`, or at the cursor. */
export function insertPictures(view: EditorView, srcs: string[], pos: number | null) {
  const nodes = srcs.map((src) => n.image.create({ src }));
  let tr = view.state.tr;
  if (pos !== null) {
    const $pos = tr.doc.resolve(pos);
    const at = $pos.depth ? $pos.after(1) : pos;
    tr = tr.insert(at, nodes);
  } else {
    for (const node of nodes) tr = tr.replaceSelectionWith(node);
  }
  view.dispatch(tr.scrollIntoView());
}

export function selectedNodeType(state: EditorState): NodeType | null {
  return state.selection instanceof NodeSelection ? state.selection.node.type : null;
}
