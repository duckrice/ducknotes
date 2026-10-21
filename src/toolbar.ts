// The toolbar over the page. Buttons show their keyboard shortcut on hover.

import { setBlockType } from "prosemirror-commands";
import type { MarkType } from "prosemirror-model";
import type { Command, EditorState } from "prosemirror-state";
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, deleteTable, isInTable } from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";
import { h } from "./dom";
import { insertEquation } from "./equation";
import { insertTable, normaliseUrl, setHeading, stepSize, setLink, toggleCheck, toggleColor, toggleList } from "./editor";
import { icon, type IconName } from "./icons";
import { schema } from "./schema";
import { toggleMark } from "prosemirror-commands";
import { popover } from "./ui";
import type { Canvas } from "./canvas";
import { COLORS, COLOR_NAMES, WIDTHS, pen, type Tool } from "./ink";
import type { Paper } from "./store";

const n = schema.nodes;
const m = schema.marks;

const HIGHLIGHTS = [
  ["#fde68a", "Yellow"],
  ["#bbf7d0", "Green"],
  ["#bfdbfe", "Blue"],
  ["#fbcfe8", "Pink"],
  ["#fed7aa", "Orange"],
];
const TEXT_COLORS = [
  ["#dc2626", "Red"],
  ["#2563eb", "Blue"],
  ["#16a34a", "Green"],
  ["#ea580c", "Orange"],
  ["#9333ea", "Purple"],
  ["#6b7280", "Grey"],
];

export interface ToolbarHooks {
  /** The text box being written in. */
  view(): EditorView | null;
  canvas(): Canvas | null;
  insertPicture(): void;
  /** Lecture slides from a PDF, to write on. */
  insertSlides(): void;
}

export function createToolbar(hooks: ToolbarHooks) {
  const updaters: ((state: EditorState) => void)[] = [];

  const run = (command: Command) => {
    const view = hooks.view();
    if (!view) return;
    command(view.state, view.dispatch, view);
    view.focus();
  };

  const button = (name: IconName, title: string, action: () => void, isActive?: (state: EditorState) => boolean, isEnabled?: (state: EditorState) => boolean) => {
    const el = h("button", { type: "button", class: "tb", title, "aria-label": title.replace(/ \(.*\)$/, ""), html: icon(name) });
    // Keep the cursor in the page while clicking.
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("click", action);
    if (isActive || isEnabled)
      updaters.push((state) => {
        if (isActive) {
          const on = isActive(state);
          el.classList.toggle("active", on);
          el.setAttribute("aria-pressed", String(on));
        }
        if (isEnabled) el.disabled = !isEnabled(state);
      });
    return el;
  };

  const markOn = (type: MarkType) => (state: EditorState) => {
    const { from, to, empty, $from } = state.selection;
    return empty ? !!type.isInSet(state.storedMarks ?? $from.marks()) : state.doc.rangeHasMark(from, to, type);
  };

  const inList = (kind: "bullet" | "number" | "check") => (state: EditorState) => {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type !== n.list_item) continue;
      const list = $from.node(d - 1).type;
      if (kind === "check") return node.attrs.checked !== null;
      return node.attrs.checked === null && list === (kind === "number" ? n.ordered_list : n.bullet_list);
    }
    return false;
  };

  // ---- the kind of line ------------------------------------------------------

  const styles: [string, string, Command][] = [
    ["p", "Normal text (Ctrl+0)", setHeading(0)],
    ["h1", "Heading 1 (Ctrl+Shift+1)", setHeading(1)],
    ["h2", "Heading 2 (Ctrl+Shift+2)", setHeading(2)],
    ["h3", "Heading 3 (Ctrl+Shift+3)", setHeading(3)],
    ["code", "Code", setBlockType(n.code_block)],
  ];
  const styleSelect = h(
    "select",
    { class: "tb-select", title: "Kind of text", "aria-label": "Kind of text" },
    ...styles.map(([value, label]) => h("option", { value }, label.replace(/ \(.*\)$/, ""))),
  ) as HTMLSelectElement;
  styleSelect.addEventListener("change", () => run(styles.find(([value]) => value === styleSelect.value)![2]));
  updaters.push((state) => {
    const parent = state.selection.$from.parent;
    styleSelect.value = parent.type === n.heading ? `h${parent.attrs.level}` : parent.type === n.code_block ? "code" : "p";
  });

  // ---- colours ------------------------------------------------------------------

  const palette = (anchor: HTMLElement, colors: string[][], type: MarkType, noneLabel: string) =>
    popover(anchor, (close) =>
      h(
        "div",
        { class: "palette" },
        ...colors.map(([color, name]) =>
          h("button", {
            type: "button",
            class: "swatch",
            title: name,
            "aria-label": name,
            style: `--swatch:${color}`,
            onmousedown: (e: Event) => e.preventDefault(),
            onclick: () => {
              run(toggleColor(type, color));
              close();
            },
          }),
        ),
        h("button", { type: "button", class: "btn subtle small", onmousedown: (e: Event) => e.preventDefault(), onclick: () => (run(toggleColor(type, null)), close()) }, noneLabel),
      ),
    );

  const highlight = button("highlight", "Highlight (Ctrl+Shift+H)", () => palette(highlight, HIGHLIGHTS, m.highlight, "No highlight"), markOn(m.highlight));
  const color = button("textColor", "Text colour", () => palette(color, TEXT_COLORS, m.color, "Automatic"), markOn(m.color));

  // ---- tables ---------------------------------------------------------------------

  const tablePicker = (anchor: HTMLElement) =>
    popover(anchor, (close) => {
      const size = 8;
      const label = h("div", { class: "grid-label" }, "Table");
      const cells: HTMLElement[] = [];
      const grid = h("div", { class: "grid-picker", role: "grid", "aria-label": "Table size" });
      const show = (rows: number, cols: number) => {
        cells.forEach((cell, i) => cell.classList.toggle("on", Math.floor(i / size) < rows && i % size < cols));
        label.textContent = `${cols} × ${rows}`;
      };
      for (let r = 1; r <= size; r++)
        for (let c = 1; c <= size; c++) {
          const cell = h("button", {
            type: "button",
            class: "grid-cell",
            "aria-label": `${c} columns, ${r} rows`,
            onmouseenter: () => show(r, c),
            onfocus: () => show(r, c),
            onmousedown: (e: Event) => e.preventDefault(),
            onclick: () => {
              close();
              run(insertTable(r, c));
            },
          });
          cells.push(cell);
          grid.append(cell);
        }
      show(3, 3);
      return h("div", {}, grid, label);
    });

  const table = button("table", "Table (Tab moves to the next cell)", () => tablePicker(table));
  const inTable = (state: EditorState) => isInTable(state);
  const tableTools = h(
    "div",
    { class: "tb-group table-tools", role: "group", "aria-label": "Table" },
    button("rowAdd", "Add a row below", () => run(addRowAfter)),
    button("colAdd", "Add a column to the right", () => run(addColumnAfter)),
    button("rowRemove", "Delete this row", () => run(deleteRow)),
    button("colRemove", "Delete this column", () => run(deleteColumn)),
    button("tableRemove", "Delete the table", () => run(deleteTable)),
  );
  updaters.push((state) => (tableTools.hidden = !inTable(state)));

  // ---- links ----------------------------------------------------------------------

  const linkButton = button("link", "Link (Ctrl+K)", () => editLink(), markOn(m.link));
  function editLink() {
    const view = hooks.view();
    if (!view) return;
    const current = m.link.isInSet(view.state.selection.$from.marks())?.attrs.href ?? "";
    popover(linkButton, (close) => {
      const input = h("input", { type: "text", class: "tb-input", placeholder: "Web or e-mail address", "aria-label": "Address", value: current }) as HTMLInputElement;
      const apply = (href: string | null) => {
        close();
        run(setLink(href));
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") apply(normaliseUrl(input.value));
      });
      setTimeout(() => input.focus());
      return h(
        "div",
        { class: "link-box" },
        input,
        h("button", { type: "button", class: "btn primary small", onclick: () => apply(normaliseUrl(input.value)) }, "OK"),
        current ? h("button", { type: "button", class: "btn subtle small", onclick: () => apply(null) }, "Remove link") : null,
      );
    });
  }

  // ---- drawing --------------------------------------------------------------------

  const toolButtons = TOOLS.map(([tool, name, title]) => {
    const b = button(name, title, () => hooks.canvas()?.setTool(tool));
    b.dataset.tool = tool;
    return b;
  });
  const swatches = COLORS.map((c, i) =>
    h("button", {
      type: "button",
      class: "swatch",
      title: COLOR_NAMES[i],
      "aria-label": COLOR_NAMES[i],
      "data-color": c,
      style: `--swatch:${c}`,
      onmousedown: (e: Event) => e.preventDefault(),
      onclick: () => {
        if (pen.tool === "highlighter") pen.marker = c;
        else pen.color = c;
        hooks.canvas()?.restyle();
        showPen();
      },
    }),
  );
  const widths = WIDTHS.map((w, i) => {
    const label = ["Thin", "Medium", "Thick"][i];
    return h(
      "button",
      {
        type: "button",
        class: "tb width",
        title: `${label} pen`,
        "aria-label": `${label} pen`,
        "data-width": String(w),
        onmousedown: (e: Event) => e.preventDefault(),
        onclick: () => {
          pen.width = w;
          hooks.canvas()?.restyle();
          showPen();
        },
      },
      h("span", { style: `height:${w}px` }),
    );
  });
  const paper = h(
    "select",
    { class: "tb-select", title: "Paper", "aria-label": "Paper" },
    h("option", { value: "plain" }, "Plain"),
    h("option", { value: "lines" }, "Lines"),
    h("option", { value: "grid" }, "Squares"),
  ) as HTMLSelectElement;
  paper.addEventListener("change", () => hooks.canvas()?.setPaper(paper.value as Paper));

  const zoomLabel = h("button", { type: "button", class: "tb zoom-label", title: "Back to 100%", "aria-label": "Zoom" }, "100%");
  zoomLabel.addEventListener("click", () => hooks.canvas()?.setZoom(1));
  const zoomBy = (factor: number) => {
    const canvas = hooks.canvas();
    if (canvas) canvas.setZoom(canvas.zoom * factor);
  };

  /** Shows which tool, colour and width are chosen. */
  function showPen() {
    for (const b of toolButtons) b.classList.toggle("active", b.dataset.tool === pen.tool);
    for (const b of swatches) b.classList.toggle("active", b.dataset.color === (pen.tool === "highlighter" ? pen.marker : pen.color));
    for (const b of widths) b.classList.toggle("active", b.dataset.width === String(pen.width));
  }

  const el = h(
    "div",
    { class: "toolbar", role: "toolbar", "aria-label": "Formatting and drawing" },
    h(
      "div",
      { class: "tb-row" },
      h(
        "div",
        { class: "tb-group" },
        button("undo", "Undo (Ctrl+Z)", () => hooks.canvas()?.undo()),
        button("redo", "Redo (Ctrl+Y)", () => hooks.canvas()?.redo()),
      ),
      h("div", { class: "tb-group" }, styleSelect),
      h(
        "div",
        { class: "tb-group" },
        button("bold", "Bold (Ctrl+B)", () => run(toggleMark(m.bold)), markOn(m.bold)),
        button("italic", "Italic (Ctrl+I)", () => run(toggleMark(m.italic)), markOn(m.italic)),
        button("underline", "Underline (Ctrl+U)", () => run(toggleMark(m.underline)), markOn(m.underline)),
        button("strike", "Strikethrough (Ctrl+-)", () => run(toggleMark(m.strike)), markOn(m.strike)),
        button("zoomIn", "Bigger text (Alt+scroll up, Ctrl+])", () => run(stepSize(1))),
        button("zoomOut", "Smaller text (Alt+scroll down, Ctrl+[)", () => run(stepSize(-1))),
        highlight,
        color,
      ),
      h(
        "div",
        { class: "tb-group" },
        button("bullets", "Bullets (Ctrl+.)", () => run(toggleList("bullet")), inList("bullet")),
        button("numbers", "Numbering (Ctrl+/)", () => run(toggleList("number")), inList("number")),
        button("checklist", "Checklist (Ctrl+1)", () => run(toggleCheck), inList("check")),
      ),
      h(
        "div",
        { class: "tb-group" },
        table,
        button("picture", "Picture (or just paste one with Ctrl+V)", () => hooks.insertPicture()),
        button("pdf", "Slides from a PDF, to write and draw on (or drop the PDF on the page)", () => hooks.insertSlides()),
        button("equation", "Equation (Alt+=)", () => {
          const view = hooks.view();
          if (view) insertEquation(view);
        }),
        linkButton,
      ),
      tableTools,
    ),
    h(
      "div",
      { class: "tb-row" },
      h("div", { class: "tb-group" }, ...toolButtons.slice(0, 5)),
      h("div", { class: "tb-group" }, ...toolButtons.slice(5)),
      h("div", { class: "tb-group" }, ...swatches),
      h("div", { class: "tb-group" }, ...widths),
      h("div", { class: "tb-group" }, paper),
    ),
  );
  /** Zooming, for the bottom right corner, as in Word. */
  const zoomBar = h(
    "div",
    { class: "zoom", role: "group", "aria-label": "Zoom" },
    button("zoomOut", "Zoom out (Ctrl+scroll down)", () => zoomBy(1 / 1.25)),
    zoomLabel,
    button("zoomIn", "Zoom in (Ctrl+scroll up)", () => zoomBy(1.25)),
  );
  showPen();

  return {
    el,
    zoomBar,
    editLink,
    showPen,
    update(state: EditorState | null) {
      el.classList.toggle("no-text", !state);
      if (state) for (const update of updaters) update(state);
    },
    showZoom(zoom: number) {
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    },
    showPaper(value: Paper) {
      paper.value = value;
    },
  };
}

const TOOLS: [Tool, IconName, string][] = [
  ["type", "textTool", "Type: click anywhere to write (T or Esc)"],
  ["select", "pointer", "Select and move drawings; drag empty space to scroll (V)"],
  ["pen", "pen", "Pen (P)"],
  ["highlighter", "marker", "Highlighter (H)"],
  ["eraser", "eraser", "Eraser (E)"],
  ["line", "line", "Line (L)"],
  ["arrow", "arrow", "Arrow: draw from one shape to another to join them (A)"],
  ["rect", "rect", "Box (R)"],
  ["ellipse", "ellipse", "Circle (O)"],
  ["diamond", "diamond", "Diamond, for decisions (D)"],
];

/** The letters that pick a tool when no text has the cursor. */
export const TOOL_KEYS: Record<string, Tool> = { t: "type", v: "select", p: "pen", h: "highlighter", e: "eraser", l: "line", a: "arrow", r: "rect", o: "ellipse", d: "diamond" };
