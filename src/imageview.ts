// A picture on a page: loaded from the notes folder, made smaller or larger
// by dragging its corner.

import type { Node } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { h } from "./dom";
import { pictureUrl } from "./store";

export class ImageView implements NodeView {
  dom: HTMLElement;
  private img: HTMLImageElement;

  constructor(
    private node: Node,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.img = h("img", { alt: node.attrs.alt, draggable: "false" });
    const handle = h("span", { class: "image-handle", title: "Drag to resize" });
    this.dom = h("div", { class: "image" }, this.img, handle);
    this.dom.addEventListener("mousedown", (event) => {
      if (event.target === handle) return;
      const pos = this.getPos();
      if (pos === undefined) return;
      event.preventDefault();
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
      this.view.focus();
    });
    handle.addEventListener("pointerdown", (event) => this.resize(event, handle));
    this.show();
  }

  private show() {
    const { src, width } = this.node.attrs;
    this.img.style.width = width ? `${width}px` : "";
    void pictureUrl(src).then(
      (url) => {
        if (this.node.attrs.src === src) this.img.src = url;
      },
      () => this.dom.classList.add("missing"),
    );
  }

  private resize(event: PointerEvent, handle: HTMLElement) {
    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const start = this.img.getBoundingClientRect().width;
    const most = this.dom.parentElement?.clientWidth ?? start;
    let width = start;
    const onMove = (e: PointerEvent) => {
      width = Math.round(Math.max(40, Math.min(most, start + e.clientX - startX)));
      this.img.style.width = `${width}px`;
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      const pos = this.getPos();
      if (pos !== undefined && width !== start) this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, width }));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.src !== this.node.attrs.src || node.attrs.width !== this.node.attrs.width;
    this.node = node;
    if (changed) this.show();
    return true;
  }

  selectNode() {
    this.dom.classList.add("selected");
  }

  deselectNode() {
    this.dom.classList.remove("selected");
  }

  stopEvent(event: Event): boolean {
    return event.type === "pointerdown" || event.type === "mousedown";
  }

  ignoreMutation(): boolean {
    return true;
  }
}
