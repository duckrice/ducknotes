// Draws an equation tree as MathML.

import type { MathNode } from "./ast";

const NS = "http://www.w3.org/1998/Math/MathML";

function el(tag: string, attrs: Record<string, string> = {}, ...children: (Element | string)[]): Element {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

const LIMITS_UNDER = new Set(["∑", "∏", "∐", "⋃", "⋂"]);
const BRACKETS = "()[]{}|‖⟨⟩⌊⌋⌈⌉";

function render(node: MathNode, display: boolean): Element {
  switch (node.t) {
    case "row":
      return el("mrow", {}, ...node.items.map((n) => render(n, display)));
    case "id":
      return el("mi", {}, node.v);
    case "num":
      return el("mn", {}, node.v);
    case "op":
      // Brackets hug what they enclose, as in Word.
      return el("mo", BRACKETS.includes(node.v) ? { lspace: "0", rspace: "0" } : {}, node.v);
    case "fn":
      return el("mi", { mathvariant: "normal" }, node.v);
    case "text":
      return el("mtext", {}, node.v);
    case "frac":
      return el("mfrac", {}, render(node.num, display), render(node.den, display));
    case "sqrt":
      return node.index ? el("mroot", {}, render(node.body, display), render(node.index, display)) : el("msqrt", {}, render(node.body, display));
    case "scripts": {
      const base = render(node.base, display);
      if (node.sub && node.sup) return el("msubsup", {}, base, render(node.sub, display), render(node.sup, display));
      if (node.sub) return el("msub", {}, base, render(node.sub, display));
      return el("msup", {}, base, render(node.sup!, display));
    }
    case "nary": {
      const op = el("mo", { largeop: "true" }, node.op);
      const under = display && LIMITS_UNDER.has(node.op);
      let big: Element = op;
      if (node.sub && node.sup) big = el(under ? "munderover" : "msubsup", {}, op, render(node.sub, display), render(node.sup, display));
      else if (node.sub) big = el(under ? "munder" : "msub", {}, op, render(node.sub, display));
      else if (node.sup) big = el(under ? "mover" : "msup", {}, op, render(node.sup, display));
      return el("mrow", {}, big, render(node.body, display));
    }
    case "limit": {
      const name = el("mi", { mathvariant: "normal" }, node.name);
      return node.under.t === "row" && node.under.items.length === 0 ? name : el(display ? "munder" : "msub", {}, name, render(node.under, display));
    }
    case "delim":
      return el(
        "mrow",
        {},
        ...(node.open ? [el("mo", { stretchy: "true" }, node.open)] : []),
        render(node.body, display),
        ...(node.close ? [el("mo", { stretchy: "true" }, node.close)] : []),
      );
    case "accent":
      return el("mover", { accent: "true" }, render(node.body, display), el("mo", { stretchy: node.chr === "̅" ? "true" : "false" }, accentShown(node.chr)));
    case "matrix": {
      const table = el("mtable", {}, ...node.rows.map((r) => el("mtr", {}, ...r.map((cell) => el("mtd", {}, render(cell, display))))));
      return el(
        "mrow",
        {},
        ...(node.open ? [el("mo", { stretchy: "true" }, node.open)] : []),
        table,
        ...(node.close ? [el("mo", { stretchy: "true" }, node.close)] : []),
      );
    }
  }
}

/** Combining accents shown on their own are drawn with their spacing forms. */
function accentShown(chr: string): string {
  return { "⃗": "→", "̂": "^", "̅": "‾", "̇": "˙", "̈": "¨", "̃": "~" }[chr] ?? chr;
}

export function toMathML(node: MathNode, display: boolean): Element {
  return el("math", display ? { display: "block" } : {}, render(node, display));
}
