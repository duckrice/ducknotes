// The equation editor: type the shorthand, see the result as you type, and
// use the buttons for the common shapes so you don't have to remember them.

import { NodeSelection, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { h } from "./dom";
import { MathSyntaxError, parseMath } from "./math/ast";
import { toMathML } from "./math/mathml";
import { schema } from "./schema";

/** Shapes the buttons insert; | marks where the cursor goes. */
const TEMPLATES: { label: string; title: string; text: string }[] = [
  { label: "x²", title: "Superscript (power): x^2", text: "^{|}" },
  { label: "x₁", title: "Subscript: x_1", text: "_{|}" },
  { label: "a⁄b", title: "Fraction: \\frac{a}{b}", text: "\\frac{|}{}" },
  { label: "√x", title: "Square root: \\sqrt{x}", text: "\\sqrt{|}" },
  { label: "ⁿ√x", title: "Root: \\sqrt[n]{x}", text: "\\sqrt[|]{}" },
  { label: "∑", title: "Sum: \\sum_{i=1}^{n}", text: "\\sum_{|}^{} " },
  { label: "∫", title: "Integral: \\int_{a}^{b}", text: "\\int_{|}^{} " },
  { label: "lim", title: "Limit: \\lim_{x \\to 0}", text: "\\lim_{| \\to } " },
  { label: "( )", title: "Brackets that grow: \\left( … \\right)", text: "\\left( | \\right)" },
  { label: "[ ]", title: "Matrix: \\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}", text: "\\begin{bmatrix} | &  \\\\  &  \\end{bmatrix}" },
  { label: "x⃗", title: "Vector: \\vec{x}", text: "\\vec{|}" },
  { label: "x̄", title: "Bar: \\bar{x}", text: "\\bar{|}" },
  { label: "sin", title: "Functions: \\sin, \\cos, \\log, \\ln …", text: "\\sin " },
  { label: "text", title: "Ordinary words: \\text{…}", text: "\\text{|}" },
];

const SYMBOL_ROWS = [
  "α β γ δ ε θ λ μ π ρ σ τ φ ω Δ Σ Ω",
  "± × ⋅ ÷ ≤ ≥ ≠ ≈ ≡ ∝ ∞ ∂ ∇ ° → ⇌ ⇒ ∈ ∀ ∃",
];

let open: { close: (commit: boolean) => void } | null = null;

/**
 * Edits the equation at `pos`. `isNew` means it was just inserted, so
 * cancelling (or leaving it empty) takes it out again.
 */
export function editEquation(view: EditorView, pos: number, isNew = false) {
  open?.close(true);
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type !== schema.nodes.math) return;

  const input = h("textarea", { class: "eq-input", rows: 2, spellcheck: "false", "aria-label": "Equation" });
  input.value = node.attrs.latex;
  const preview = h("div", { class: "eq-preview" });
  const message = h("div", { class: "eq-message" });
  const display = h("input", { type: "checkbox" }) as HTMLInputElement;
  display.checked = node.attrs.display;

  const insert = (text: string) => {
    const [before, after] = text.split("|");
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = input.value.slice(start, end);
    input.setRangeText(before + selected + (after ?? ""), start, end, "end");
    const caret = start + before.length + selected.length;
    if (after !== undefined) input.setSelectionRange(caret, caret);
    input.focus();
    draw();
  };

  const templates = h(
    "div",
    { class: "eq-templates" },
    ...TEMPLATES.map((t) => h("button", { type: "button", class: "eq-template", title: t.title, onclick: () => insert(t.text) }, t.label)),
  );
  const symbols = h(
    "div",
    { class: "eq-symbols" },
    ...SYMBOL_ROWS.join(" ").split(" ").map((s) => h("button", { type: "button", class: "eq-symbol", title: s, onclick: () => insert(s) }, s)),
  );
  const done = h("button", { type: "button", class: "btn primary small" }, "Done");
  const remove = h("button", { type: "button", class: "btn subtle small" }, "Remove");
  const box = h(
    "div",
    { class: "eq-editor", role: "dialog", "aria-label": "Equation" },
    templates,
    symbols,
    input,
    preview,
    message,
    h(
      "div",
      { class: "eq-footer" },
      h("label", { class: "eq-display" }, display, "On its own line"),
      h("span", { class: "eq-help" }, "Enter to finish · Esc to cancel"),
      remove,
      done,
    ),
  );

  function draw() {
    preview.replaceChildren();
    message.textContent = "";
    if (!input.value.trim()) {
      preview.textContent = "";
      return;
    }
    try {
      preview.append(toMathML(parseMath(input.value), display.checked));
    } catch (error) {
      message.textContent = error instanceof MathSyntaxError ? error.message : "This equation can't be shown";
    }
  }

  function close(commit: boolean) {
    if (open?.close !== close) return;
    open = null;
    box.remove();
    document.removeEventListener("mousedown", outside, true);
    const current = view.state.doc.nodeAt(pos);
    if (!current || current.type !== schema.nodes.math) return;
    const latex = input.value.trim();
    const tr = view.state.tr;
    if ((!commit && isNew) || (commit && !latex)) {
      tr.delete(pos, pos + current.nodeSize);
      tr.setSelection(TextSelection.create(tr.doc, Math.min(pos, tr.doc.content.size)));
    } else if (commit && (latex !== current.attrs.latex || display.checked !== current.attrs.display)) {
      tr.setNodeMarkup(pos, undefined, { ...current.attrs, latex, display: display.checked });
      tr.setSelection(TextSelection.create(tr.doc, pos + current.nodeSize));
    } else tr.setSelection(TextSelection.create(tr.doc, pos + current.nodeSize));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }

  function outside(event: MouseEvent) {
    if (!box.contains(event.target as Node)) close(true);
  }

  input.addEventListener("input", draw);
  display.addEventListener("change", draw);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      close(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(false);
    }
  });
  done.addEventListener("click", () => close(true));
  remove.addEventListener("click", () => {
    input.value = "";
    close(true);
  });

  // Under the equation, inside the window.
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
  const coords = view.coordsAtPos(pos);
  document.body.append(box);
  const width = box.offsetWidth;
  box.style.left = `${Math.max(8, Math.min(coords.left - 20, window.innerWidth - width - 8))}px`;
  const below = coords.bottom + 8;
  box.style.top = `${below + box.offsetHeight > window.innerHeight - 8 ? Math.max(8, coords.top - box.offsetHeight - 8) : below}px`;
  open = { close };
  setTimeout(() => document.addEventListener("mousedown", outside, true));
  draw();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/** Inserts a new equation at the cursor (from the selected text, if any) and opens it for editing. */
export function insertEquation(view: EditorView) {
  const { state } = view;
  const { from, to, $from, empty } = state.selection;
  const text = empty ? "" : state.doc.textBetween(from, to, " ");
  // In an empty paragraph the equation gets its own line.
  const display = empty && $from.parent.content.size === 0;
  const node = schema.nodes.math.create({ latex: text, display });
  const tr = state.tr.replaceSelectionWith(node, false);
  view.dispatch(tr);
  editEquation(view, tr.mapping.map(from, -1), true);
}

