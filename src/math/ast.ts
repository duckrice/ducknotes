// Equations as a small tree, written in a LaTeX-like shorthand that most
// students and scientists already know: x^2, a_{ij}, \frac{a}{b}, \sqrt{x},
// \alpha, \sum_{i=1}^{n}, \int_0^1, \left( … \right), \vec{v}.
//
// The tree is turned into MathML to show it, and into Word's own equation
// format (OMML) to save it; equations read from Word come back as a tree.

export type MathNode =
  | { t: "row"; items: MathNode[] }
  /** A variable, drawn in italics. */
  | { t: "id"; v: string }
  | { t: "num"; v: string }
  /** An operator or symbol: + = ≤ → ( … */
  | { t: "op"; v: string }
  /** A function or unit name, upright: sin, log, mol. */
  | { t: "fn"; v: string }
  | { t: "text"; v: string }
  | { t: "frac"; num: MathNode; den: MathNode }
  | { t: "sqrt"; body: MathNode; index?: MathNode }
  | { t: "scripts"; base: MathNode; sub?: MathNode; sup?: MathNode }
  /** A big operator with limits: ∑ ∏ ∫ … */
  | { t: "nary"; op: string; sub?: MathNode; sup?: MathNode; body: MathNode }
  /** lim, max, min with something under it. */
  | { t: "limit"; name: string; under: MathNode }
  | { t: "delim"; open: string; close: string; body: MathNode }
  | { t: "accent"; chr: string; body: MathNode }
  | { t: "matrix"; rows: MathNode[][]; open: string; close: string };

export const row = (items: MathNode[]): MathNode => (items.length === 1 ? items[0] : { t: "row", items });

/** Greek letters and symbols by their LaTeX names. */
export const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ",
  sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  pm: "±", mp: "∓", times: "×", cdot: "⋅", div: "÷", ast: "∗", star: "⋆", circ: "∘", bullet: "∙",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", cong: "≅",
  propto: "∝", ll: "≪", gg: "≫", infty: "∞", partial: "∂", nabla: "∇", degree: "°",
  to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔",
  implies: "⇒", iff: "⇔", mapsto: "↦", uparrow: "↑", downarrow: "↓", rightleftharpoons: "⇌",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇", cup: "∪", cap: "∩",
  emptyset: "∅", varnothing: "∅", forall: "∀", exists: "∃", neg: "¬", land: "∧", lor: "∨", wedge: "∧", vee: "∨",
  angle: "∠", perp: "⊥", parallel: "∥", mid: "∣", prime: "′", hbar: "ℏ", ell: "ℓ", Re: "ℜ", Im: "ℑ", aleph: "ℵ",
  ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", dots: "…", therefore: "∴", because: "∵",
  langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", vert: "|", Vert: "‖",
  quad: " ", qquad: "  ", ",": " ", ";": " ", " ": " ", "!": "", "{": "{", "}": "}",
  "%": "%", "#": "#", "&": "&", _: "_", $: "$",
};

/** Big operators, by LaTeX name. */
export const NARY: Record<string, string> = {
  sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮", bigcup: "⋃", bigcap: "⋂",
};

/** Function names drawn upright. */
export const FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth",
  "log", "ln", "lg", "exp", "det", "dim", "ker", "deg", "gcd", "arg", "sgn", "Pr", "mod",
]);
export const LIMITS = new Set(["lim", "max", "min", "sup", "inf", "limsup", "liminf"]);

export const ACCENTS: Record<string, string> = {
  vec: "⃗", hat: "̂", widehat: "̂", bar: "̅", overline: "̅", dot: "̇", ddot: "̈",
  tilde: "̃", widetilde: "̃",
};

const BRACKETS: Record<string, [string, string]> = {
  matrix: ["", ""], pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"], vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"],
};

export class MathSyntaxError extends Error {}

/** Parses the shorthand into a tree. Throws MathSyntaxError with a plain message when it can't. */
export function parseMath(source: string): MathNode {
  const p = new Parser(source);
  const node = p.row(() => p.done());
  if (!p.done()) throw new MathSyntaxError(`Unexpected "${p.peek()}"`);
  return node;
}

class Parser {
  private i = 0;
  constructor(private s: string) {}

  done = () => this.i >= this.s.length;
  peek = () => this.s[this.i];

  private skipSpace() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  /** Items until `stop` says so; big operators take the terms after them as their body. */
  row(stop: () => boolean): MathNode {
    const items: MathNode[] = [];
    for (;;) {
      this.skipSpace();
      if (this.done() || stop()) break;
      const item = this.term();
      if (item.t === "nary") {
        // ∑ x_i + 1: the body runs to the next +, −, = or relation at this level.
        const body: MathNode[] = [];
        for (;;) {
          this.skipSpace();
          if (this.done() || stop() || /^[+\-=<>,]/.test(this.peek()) || this.atRelation()) break;
          body.push(this.term());
        }
        items.push({ ...item, body: row(body) });
      } else items.push(item);
    }
    return items.length === 1 ? items[0] : { t: "row", items };
  }

  private atRelation(): boolean {
    const m = /^\\([a-zA-Z]+)/.exec(this.s.slice(this.i));
    return !!m && ["le", "leq", "ge", "geq", "ne", "neq", "approx", "equiv", "to", "rightarrow", "Rightarrow", "pm", "mp", "right"].includes(m[1]);
  }

  /** One thing with its subscript and superscript. */
  private term(): MathNode {
    let base = this.atom();
    let sub: MathNode | undefined;
    let sup: MathNode | undefined;
    for (;;) {
      this.skipSpace();
      const c = this.peek();
      if (c === "_" && !sub) {
        this.i++;
        sub = this.argument();
      } else if (c === "^" && !sup) {
        this.i++;
        sup = this.argument();
      } else if (c === "'" ) {
        this.i++;
        sup = sup ? row([sup, { t: "op", v: "′" }]) : { t: "op", v: "′" };
      } else break;
    }
    if (!sub && !sup) return base;
    if (base.t === "nary") return { ...base, sub: sub ?? base.sub, sup: sup ?? base.sup };
    if (base.t === "limit" && sub) return { ...base, under: sub };
    if (base.t === "row" && base.items.length === 0) base = { t: "text", v: "" };
    return { t: "scripts", base, sub, sup };
  }

  /** What follows ^ or _ (or a command): a {group} or a single character or command. */
  private argument(): MathNode {
    this.skipSpace();
    if (this.done()) throw new MathSyntaxError("Something is missing at the end");
    if (this.peek() === "{") return this.group();
    if (this.peek() === "\\") return this.atom();
    const c = this.s[this.i++];
    return /\d/.test(c) ? { t: "num", v: c } : /[a-zA-Z]/.test(c) ? { t: "id", v: c } : { t: "op", v: c };
  }

  private group(): MathNode {
    this.i++; // {
    const body = this.row(() => this.peek() === "}");
    if (this.peek() !== "}") throw new MathSyntaxError("A { has no matching }");
    this.i++;
    return body.t === "row" || body.t !== undefined ? body : row([]);
  }

  private atom(): MathNode {
    this.skipSpace();
    const c = this.peek();
    if (c === "{") return this.group();
    if (c === "}") throw new MathSyntaxError("A } has no matching {");
    if (c === "\\") return this.command();
    if (/\d/.test(c)) {
      const m = /^\d+(?:[.,]\d+)?/.exec(this.s.slice(this.i))!;
      this.i += m[0].length;
      return { t: "num", v: m[0] };
    }
    if (/[a-zA-Z]/.test(c)) {
      this.i++;
      return { t: "id", v: c };
    }
    if (c === "^" || c === "_") throw new MathSyntaxError(`"${c}" needs something before it`);
    this.i++;
    const op = c === "-" ? "−" : c === "*" ? "∗" : c;
    return /[\p{L}]/u.test(c) ? { t: "id", v: c } : { t: "op", v: op };
  }

  private name(): string {
    this.i++; // backslash
    const m = /^([a-zA-Z]+|.)/.exec(this.s.slice(this.i));
    if (!m) throw new MathSyntaxError("A \\ needs a name after it");
    this.i += m[0].length;
    return m[0];
  }

  private command(): MathNode {
    const name = this.name();
    if (name === "frac" || name === "dfrac" || name === "tfrac") return { t: "frac", num: this.argument(), den: this.argument() };
    if (name === "sqrt") {
      this.skipSpace();
      let index: MathNode | undefined;
      if (this.peek() === "[") {
        this.i++;
        index = this.row(() => this.peek() === "]");
        if (this.peek() !== "]") throw new MathSyntaxError("A [ has no matching ]");
        this.i++;
      }
      return { t: "sqrt", body: this.argument(), index };
    }
    if (NARY[name]) return { t: "nary", op: NARY[name], body: row([]) };
    if (LIMITS.has(name)) return { t: "limit", name, under: row([]) };
    if (FUNCTIONS.has(name)) return { t: "fn", v: name };
    if (ACCENTS[name]) return { t: "accent", chr: ACCENTS[name], body: this.argument() };
    if (name === "text" || name === "mathrm" || name === "textrm" || name === "operatorname") {
      this.skipSpace();
      if (this.peek() !== "{") throw new MathSyntaxError(`\\${name} needs {text}`);
      const end = this.s.indexOf("}", this.i);
      if (end < 0) throw new MathSyntaxError("A { has no matching }");
      const v = this.s.slice(this.i + 1, end);
      this.i = end + 1;
      return name === "text" || name === "textrm" ? { t: "text", v } : { t: "fn", v };
    }
    if (name === "left") {
      const open = this.delimiter();
      const body = this.row(() => this.s.startsWith("\\right", this.i));
      if (!this.s.startsWith("\\right", this.i)) throw new MathSyntaxError("\\left needs a \\right");
      this.i += 6;
      return { t: "delim", open, close: this.delimiter(), body };
    }
    if (name === "right") throw new MathSyntaxError("\\right needs a \\left before it");
    if (name === "begin") return this.matrix();
    if (SYMBOLS[name] !== undefined) {
      const v = SYMBOLS[name];
      return /^[\p{L}]$/u.test(v) && !"∂∇ℏℓ".includes(v) ? { t: "id", v } : { t: "op", v };
    }
    throw new MathSyntaxError(`Unknown command \\${name}`);
  }

  private delimiter(): string {
    this.skipSpace();
    if (this.peek() === "\\") {
      const name = this.name();
      if (name === ".") return "";
      if (name === "{" || name === "}") return name;
      const v = SYMBOLS[name];
      if (v === undefined) throw new MathSyntaxError(`Unknown bracket \\${name}`);
      return v;
    }
    const c = this.s[this.i++];
    return c === "." ? "" : c;
  }

  private matrix(): MathNode {
    this.skipSpace();
    const m = /^\{([a-zA-Z]+)\}/.exec(this.s.slice(this.i));
    if (!m || !BRACKETS[m[1]]) throw new MathSyntaxError("\\begin works with matrix, pmatrix, bmatrix, vmatrix");
    this.i += m[0].length;
    const end = `\\end{${m[1]}}`;
    const rows: MathNode[][] = [[]];
    for (;;) {
      this.skipSpace();
      if (this.done()) throw new MathSyntaxError(`${end} is missing`);
      if (this.s.startsWith(end, this.i)) {
        this.i += end.length;
        break;
      }
      const cell = this.row(() => this.peek() === "&" || this.s.startsWith("\\\\", this.i) || this.s.startsWith(end, this.i));
      rows[rows.length - 1].push(cell);
      if (this.peek() === "&") this.i++;
      else if (this.s.startsWith("\\\\", this.i)) {
        this.i += 2;
        rows.push([]);
      }
    }
    if (!rows[rows.length - 1].length) rows.pop();
    const [open, close] = BRACKETS[m[1]];
    return { t: "matrix", rows, open, close };
  }
}

// ---- back to the shorthand ---------------------------------------------------------

const NAME_OF = new Map<string, string>();
for (const [name, v] of Object.entries(SYMBOLS)) if (!NAME_OF.has(v) && name.length > 1) NAME_OF.set(v, name);
for (const [name, v] of Object.entries(NARY)) NAME_OF.set(v, name);
NAME_OF.set("ε", "varepsilon");
NAME_OF.set("φ", "varphi");

const groupIfNeeded = (node: MathNode) => {
  const s = toLatex(node);
  return [...s].length === 1 || /^\\[a-zA-Z]+$/.test(s) ? s : `{${s}}`;
};

/** The shorthand for a tree, for editing an equation that came from a file. */
export function toLatex(node: MathNode): string {
  switch (node.t) {
    case "row": {
      let out = "";
      for (const item of node.items) {
        const s = toLatex(item);
        // Keep commands apart from letters that follow them.
        if (/\\[a-zA-Z]+$/.test(out) && /^[a-zA-Z]/.test(s)) out += " ";
        out += s;
      }
      return out;
    }
    case "id":
    case "op": {
      if (node.v === "−") return "-";
      const name = NAME_OF.get(node.v);
      if (name && !/^[a-zA-Z0-9]$/.test(node.v)) return `\\${name}`;
      if (node.v === "{" || node.v === "}") return `\\${node.v}`;
      return node.v;
    }
    case "num":
      return node.v;
    case "fn":
      return FUNCTIONS.has(node.v) ? `\\${node.v}` : `\\mathrm{${node.v}}`;
    case "text":
      return `\\text{${node.v}}`;
    case "frac":
      return `\\frac{${toLatex(node.num)}}{${toLatex(node.den)}}`;
    case "sqrt":
      return node.index ? `\\sqrt[${toLatex(node.index)}]{${toLatex(node.body)}}` : `\\sqrt{${toLatex(node.body)}}`;
    case "scripts":
      return `${groupBase(node.base)}${node.sub ? `_${groupIfNeeded(node.sub)}` : ""}${node.sup ? `^${groupIfNeeded(node.sup)}` : ""}`;
    case "nary":
      return `\\${NAME_OF.get(node.op) ?? "sum"}${node.sub ? `_${groupIfNeeded(node.sub)}` : ""}${node.sup ? `^${groupIfNeeded(node.sup)}` : ""} ${toLatex(node.body)}`.trimEnd();
    case "limit":
      return `\\${node.name}${isEmpty(node.under) ? "" : `_${groupIfNeeded(node.under)}`}`;
    case "delim":
      return `\\left${delimLatex(node.open)} ${toLatex(node.body)} \\right${delimLatex(node.close)}`;
    case "accent": {
      const name = Object.entries(ACCENTS).find(([, chr]) => chr === node.chr)?.[0] ?? "hat";
      return `\\${name}{${toLatex(node.body)}}`;
    }
    case "matrix": {
      const kind = Object.entries(BRACKETS).find(([, [o, c]]) => o === node.open && c === node.close)?.[0] ?? "matrix";
      return `\\begin{${kind}} ${node.rows.map((r) => r.map(toLatex).join(" & ")).join(" \\\\ ")} \\end{${kind}}`;
    }
  }
}

function groupBase(node: MathNode): string {
  const s = toLatex(node);
  return node.t === "id" || node.t === "num" || node.t === "op" || node.t === "fn" || node.t === "delim" || node.t === "text" ? s : `{${s}}`;
}

function delimLatex(d: string): string {
  if (!d) return ".";
  if (d === "{" || d === "}") return `\\${d}`;
  const name = NAME_OF.get(d);
  return name ? `\\${name}` : d;
}

export const isEmpty = (node: MathNode) => node.t === "row" && node.items.length === 0;
