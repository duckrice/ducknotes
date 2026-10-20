// Shows an equation in the text as typeset math; clicking it opens the editor.

import type { Node } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import { MathSyntaxError, parseMath } from "./math/ast";
import { toMathML } from "./math/mathml";

export type EditMath = (pos: number) => void;

export class MathView implements NodeView {
  dom: HTMLElement;

  constructor(
    private node: Node,
    private view: EditorView,
    private getPos: () => number | undefined,
    private edit: EditMath,
  ) {
    this.dom = document.createElement("span");
    this.dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const pos = this.getPos();
      if (pos !== undefined && this.view.editable) this.edit(pos);
    });
    this.draw();
  }

  private draw() {
    const { latex, display } = this.node.attrs;
    this.dom.className = `math${display ? " display" : ""}`;
    this.dom.title = "Click to edit the equation";
    this.dom.replaceChildren();
    if (!latex.trim()) {
      this.dom.classList.add("empty");
      this.dom.textContent = "Type an equation";
      return;
    }
    try {
      this.dom.append(toMathML(parseMath(latex), display));
    } catch (error) {
      this.dom.classList.add("error");
      this.dom.textContent = latex;
      this.dom.title = error instanceof MathSyntaxError ? `${error.message}. Click to fix.` : "Click to edit the equation";
    }
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.latex !== this.node.attrs.latex || node.attrs.display !== this.node.attrs.display;
    this.node = node;
    if (changed) this.draw();
    return true;
  }

  selectNode() {
    this.dom.classList.add("selected");
  }

  deselectNode() {
    this.dom.classList.remove("selected");
  }

  ignoreMutation() {
    return true;
  }

  stopEvent(event: Event) {
    return event.type === "mousedown";
  }
}
