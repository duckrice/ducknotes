// What a note can hold: text with headings, lists and checklists, tables,
// pictures and equations. Saved as ProseMirror's own JSON, one text box at a time.

import { Schema, type DOMOutputSpec, type NodeSpec } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

const tables = tableNodes({ tableGroup: "block", cellContent: "block+", cellAttributes: {} });

/** Only pictures that are part of the notes (or pasted inline) show; the app doesn't load from the web. */
const localPicture = (src: string) => src.startsWith(".media/") || src.startsWith("data:image/");

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },
  paragraph: {
    group: "block",
    content: "inline*",
    /** A tag, as in OneNote: "important", "question" or "exam". */
    attrs: { tag: { default: null } },
    parseDOM: [{ tag: "p", getAttrs: (dom) => ({ tag: (dom as HTMLElement).getAttribute("data-tag") || null }) }],
    toDOM: (node) => (node.attrs.tag ? ["p", { "data-tag": node.attrs.tag, class: "tagged" }, 0] : ["p", 0]),
  },
  heading: {
    group: "block",
    content: "inline*",
    attrs: { level: { default: 1 } },
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level: Math.min(level, 3) } })),
    toDOM: (node) => [`h${node.attrs.level}`, 0],
  },
  blockquote: {
    group: "block",
    content: "block+",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM: () => ["blockquote", 0],
  },
  code_block: {
    group: "block",
    content: "text*",
    marks: "",
    code: true,
    defining: true,
    parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
    toDOM: () => ["pre", ["code", 0]],
  },
  horizontal_rule: {
    group: "block",
    parseDOM: [{ tag: "hr" }],
    toDOM: () => ["hr"],
  },
  bullet_list: {
    group: "block",
    content: "list_item+",
    parseDOM: [{ tag: "ul" }],
    toDOM: () => ["ul", 0],
  },
  ordered_list: {
    group: "block",
    content: "list_item+",
    attrs: { order: { default: 1 } },
    parseDOM: [{ tag: "ol", getAttrs: (dom) => ({ order: Number((dom as HTMLElement).getAttribute("start") ?? 1) || 1 }) }],
    toDOM: (node) => (node.attrs.order === 1 ? ["ol", 0] : ["ol", { start: node.attrs.order }, 0]),
  },
  list_item: {
    content: "paragraph block*",
    /** null for an ordinary item; true or false for a checklist item, ticked or not. */
    attrs: { checked: { default: null } },
    defining: true,
    parseDOM: [
      {
        tag: "li",
        getAttrs: (dom) => {
          const value = (dom as HTMLElement).getAttribute("data-checked");
          return { checked: value === null ? null : value === "true" };
        },
      },
    ],
    toDOM: (node) => (node.attrs.checked === null ? ["li", 0] : ["li", { class: "task", "data-checked": String(node.attrs.checked) }, 0]),
  },
  ...tables,
  image: {
    group: "block",
    attrs: { src: {}, width: { default: null }, alt: { default: "" } },
    draggable: true,
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (dom) => {
          const src = (dom as HTMLElement).getAttribute("src") ?? "";
          return localPicture(src) ? { src, alt: (dom as HTMLElement).getAttribute("alt") ?? "" } : false;
        },
      },
    ],
    toDOM: (node) => ["img", { src: node.attrs.src, alt: node.attrs.alt }],
  },
  /** An equation in a LaTeX-like shorthand: x^2, \frac{a}{b}, \sqrt{x}. */
  math: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { latex: { default: "" }, display: { default: false } },
    parseDOM: [{ tag: "span.math[data-latex]", getAttrs: (dom) => ({ latex: (dom as HTMLElement).dataset.latex ?? "" }) }],
    toDOM: (node) => ["span", { class: "math", "data-latex": node.attrs.latex }, node.attrs.latex],
  },
  text: { group: "inline" },
  hard_break: {
    group: "inline",
    inline: true,
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },
};

const colorStyle = (dom: HTMLElement, property: "color" | "backgroundColor") => dom.style[property] || false;

export const schema = new Schema({
  nodes,
  marks: {
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [{ tag: "a[href]", getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute("href") }) }],
      toDOM: (mark): DOMOutputSpec => ["a", { href: mark.attrs.href, title: `${mark.attrs.href}\nCtrl+click to open` }, 0],
    },
    bold: {
      parseDOM: [{ tag: "strong" }, { tag: "b", getAttrs: (dom) => (dom as HTMLElement).style.fontWeight !== "normal" && null }, { style: "font-weight=bold" }],
      toDOM: () => ["strong", 0],
    },
    italic: {
      parseDOM: [{ tag: "em" }, { tag: "i" }, { style: "font-style=italic" }],
      toDOM: () => ["em", 0],
    },
    underline: {
      parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }],
      toDOM: () => ["u", 0],
    },
    strike: {
      parseDOM: [{ tag: "s" }, { tag: "del" }, { style: "text-decoration=line-through" }],
      toDOM: () => ["s", 0],
    },
    code: {
      parseDOM: [{ tag: "code" }],
      toDOM: () => ["code", 0],
    },
    highlight: {
      attrs: { color: { default: "#fde68a" } },
      parseDOM: [
        { tag: "mark", getAttrs: (dom) => ({ color: (dom as HTMLElement).style.backgroundColor || "#fde68a" }) },
        { tag: "span", getAttrs: (dom) => (colorStyle(dom as HTMLElement, "backgroundColor") ? { color: (dom as HTMLElement).style.backgroundColor } : false) },
      ],
      toDOM: (mark) => ["mark", { style: `background-color:${mark.attrs.color}` }, 0],
    },
    /** Text size in pixels; Alt+scroll wheel makes it bigger or smaller. */
    size: {
      attrs: { px: {} },
      parseDOM: [{ style: "font-size", getAttrs: (value) => (/^\d+(\.\d+)?px$/.test(value) ? { px: parseFloat(value) } : false) }],
      toDOM: (mark) => ["span", { style: `font-size:${mark.attrs.px}px` }, 0],
    },
    color: {
      attrs: { color: {} },
      parseDOM: [{ tag: "span", getAttrs: (dom) => (colorStyle(dom as HTMLElement, "color") ? { color: (dom as HTMLElement).style.color } : false) }],
      toDOM: (mark) => ["span", { style: `color:${mark.attrs.color}` }, 0],
    },
  },
});

/** An empty note. */
export const emptyDoc = () => schema.node("doc", null, [schema.node("paragraph")]);
