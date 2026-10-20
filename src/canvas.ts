// A page, OneNote style: an endless sheet to click anywhere on and type,
// paste pictures onto, and draw over. Text sits in boxes that can be moved
// and resized; pictures can be moved and resized; ink and shapes lie on top.
// Ctrl+scroll wheel zooms; dragging an empty spot moves the view.

import { redo as editorRedo, undo as editorUndo, undoDepth } from "prosemirror-history";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { h } from "./dom";
import { createState, createView, insertPictures, searchKey, stepSize } from "./editor";
import { bounds, newItemId, type Item } from "./geometry";
import { InkLayer, pen, type Tool } from "./ink";
import { emptyDoc, schema } from "./schema";
import { pictureUrl, savePicture, type BoxItem, type PageFile, type PageItem, type Paper, type PictureItem } from "./store";

const LEFT = 48;
const TOP = 110;
const BOX_WIDTH = 520;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
/** Room to keep writing past the last thing on the page. */
const ROOM = 600;

export interface CanvasHooks {
  /** Something changed that should be saved. */
  onChange(): void;
  /** The text box being written in changed, or what's selected in it. */
  onActive(view: EditorView | null): void;
  onTitle(title: string): void;
  onZoom(zoom: number): void;
  onTool(tool: Tool): void;
}

interface Snapshot {
  boxes: BoxItem[];
  pictures: PictureItem[];
  ink: Item[];
}

const isEmpty = (view: EditorView) => {
  const doc = view.state.doc;
  return doc.childCount === 1 && doc.firstChild!.isTextblock && doc.firstChild!.content.size === 0;
};

class TextBox {
  el: HTMLElement;
  view: EditorView;

  constructor(
    public item: Omit<BoxItem, "doc">,
    doc: unknown,
    canvas: Canvas,
  ) {
    const body = h("div", { class: "box-body" });
    const bar = h("div", { class: "box-bar", title: "Drag to move. Click, then Delete, to remove." });
    const grip = h("div", { class: "box-grip", title: "Drag to make wider or narrower" });
    this.el = h("div", { class: "box", "data-id": item.id }, bar, body, grip);
    let node = emptyDoc();
    try {
      if (doc) node = schema.nodeFromJSON(doc);
    } catch (error) {
      console.error("A text box could not be read", error);
    }
    this.view = createView(body, createState(node), {
      onChange: (view, docChanged) => canvas.textChanged(view, docChanged),
      onPictures: (files, _view, pos) => void canvas.picturesInBox(this, files, pos),
    });
    this.view.dom.addEventListener("focus", () => canvas.focused(this));
    this.el.addEventListener("focusout", (event) => {
      if (!this.el.contains(event.relatedTarget as Node)) setTimeout(() => canvas.leftBox(this));
    });
    bar.addEventListener("pointerdown", (event) => canvas.dragObject(event, this.item.id, "move"));
    grip.addEventListener("pointerdown", (event) => canvas.dragObject(event, this.item.id, "width"));
    this.place();
  }

  place() {
    this.el.style.left = `${this.item.x}px`;
    this.el.style.top = `${this.item.y}px`;
    this.el.style.width = `${this.item.w}px`;
  }

  toItem(): BoxItem {
    return { ...this.item, t: "box", doc: this.view.state.doc.toJSON() };
  }
}

class Picture {
  el: HTMLElement;

  constructor(
    public item: PictureItem,
    canvas: Canvas,
  ) {
    const img = h("img", { alt: "", draggable: "false" });
    const handle = h("span", { class: "picture-handle", title: "Drag to resize" });
    this.el = h("div", { class: "picture", "data-id": item.id }, img, handle);
    void pictureUrl(item.src).then(
      (url) => (img.src = url),
      () => this.el.classList.add("missing"),
    );
    img.addEventListener("load", () => canvas.fit());
    this.el.addEventListener("pointerdown", (event) => canvas.dragObject(event, item.id, event.target === handle ? "width" : "move"));
    this.place();
  }

  place() {
    this.el.style.left = `${this.item.x}px`;
    this.el.style.top = `${this.item.y}px`;
    this.el.style.width = `${this.item.w}px`;
  }
}

export class Canvas {
  readonly scroller: HTMLElement;
  readonly world: HTMLElement;
  readonly title: HTMLInputElement;
  private date: HTMLElement;
  private ink: InkLayer;
  private inkItems: Item[];
  private boxes = new Map<string, TextBox>();
  private pictures = new Map<string, Picture>();
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  /** Whether the last change was to the canvas (moving, drawing) rather than to text. */
  private lastWasCanvas = false;
  /** The text box last written in. */
  active: TextBox | null = null;
  /** A picture or text box picked with a click, for moving or deleting. */
  private chosen: string | null = null;
  /** Where the next pasted thing goes: the last place clicked. */
  private spot: [number, number] | null = null;
  zoom = 1;
  paper: Paper;
  private wheelSteps = 0;
  private resize = new ResizeObserver(() => this.fit());

  constructor(
    host: HTMLElement,
    private page: PageFile,
    private hooks: CanvasHooks,
    zoom: number,
  ) {
    this.title = h("input", { type: "text", class: "page-title", placeholder: "Untitled page", "aria-label": "Page title", spellcheck: "true" }) as HTMLInputElement;
    this.title.value = page.title;
    this.date = h("div", { class: "page-date" }, new Date(page.created || Date.now()).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }));
    this.world = h("div", { class: "world" }, h("div", { class: "page-head" }, this.title, this.date));
    this.scroller = h("div", { class: "canvas-scroll" }, this.world);
    host.append(this.scroller);
    this.paper = page.paper;
    this.world.dataset.paper = page.paper;

    this.inkItems = page.items.filter((item): item is Item => item.t !== "box" && item.t !== "picture");
    this.ink = new InkLayer({
      items: () => this.inkItems,
      commit: (items) => {
        this.record();
        this.inkItems = items;
        this.ink.draw();
        this.changed(true);
      },
      point: (event) => this.point(event),
      zoom: () => this.zoom,
      world: this.world,
    });
    this.world.append(this.ink.svg);
    for (const item of page.items) {
      if (item.t === "box") this.addBox(item, item.doc);
      else if (item.t === "picture") this.addPicture(item);
    }
    this.ink.draw();
    this.setTool(pen.tool);

    this.title.addEventListener("input", () => this.hooks.onTitle(this.title.value.trim()));
    this.title.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== "ArrowDown") return;
      event.preventDefault();
      // Into the first text box, or a new one under the title.
      const first = [...this.boxes.values()].sort((a, b) => a.item.y - b.item.y)[0];
      (first ?? this.newBox(LEFT, TOP)).view.focus();
    });
    this.world.addEventListener("pointerdown", (event) => this.capture(event), true);
    this.world.addEventListener("pointerdown", (event) => this.down(event));
    this.world.addEventListener("pointermove", (event) => {
      if (this.ink.drawing) this.ink.move(event);
    });
    this.world.addEventListener("pointerup", (event) => {
      if (this.ink.drawing) this.ink.up(event);
    });
    this.world.addEventListener("dragover", (event) => event.preventDefault());
    this.world.addEventListener("drop", (event) => this.drop(event));
    this.scroller.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    this.setZoom(zoom);
    this.fit();
  }

  // ---- where things are ---------------------------------------------------------

  /** How much bigger the page shows than its own units, measured rather than assumed. */
  private get scale(): number {
    return this.world.getBoundingClientRect().width / (parseFloat(this.world.style.width) || 1) || this.zoom;
  }

  /** Where an event is on the page, in page units. */
  point(event: MouseEvent): [number, number] {
    const r = this.world.getBoundingClientRect();
    const s = this.scale;
    return [Math.round(((event.clientX - r.left) / s) * 10) / 10, Math.round(((event.clientY - r.top) / s) * 10) / 10];
  }

  /** Makes the page big enough for everything on it, with room to spare. */
  fit() {
    const s = this.scale;
    let right = this.scroller.clientWidth / this.zoom;
    let bottom = this.scroller.clientHeight / this.zoom;
    const grow = (x: number, y: number) => {
      right = Math.max(right, x + ROOM / 2);
      bottom = Math.max(bottom, y + ROOM);
    };
    for (const box of this.boxes.values()) grow(box.item.x + box.item.w, box.item.y + box.el.getBoundingClientRect().height / s);
    for (const pic of this.pictures.values()) grow(pic.item.x + pic.item.w, pic.item.y + pic.el.getBoundingClientRect().height / s);
    const byId = new Map(this.inkItems.map((item) => [item.id, item]));
    for (const item of this.inkItems) {
      const b = bounds(item, byId);
      grow(b.x + b.w, b.y + b.h);
    }
    this.world.style.width = `${Math.ceil(right)}px`;
    this.world.style.height = `${Math.ceil(bottom)}px`;
    this.ink.svg.setAttribute("width", String(Math.ceil(right)));
    this.ink.svg.setAttribute("height", String(Math.ceil(bottom)));
  }

  /** Zooms, keeping the point under the mouse (or the middle of the view) where it is. */
  setZoom(zoom: number, clientX?: number, clientY?: number) {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100));
    const r = this.scroller.getBoundingClientRect();
    const ax = (clientX ?? r.left + r.width / 2) - r.left;
    const ay = (clientY ?? r.top + r.height / 2) - r.top;
    const wx = (this.scroller.scrollLeft + ax) / this.zoom;
    const wy = (this.scroller.scrollTop + ay) / this.zoom;
    this.zoom = next;
    this.world.style.zoom = String(next);
    this.fit();
    this.scroller.scrollLeft = wx * next - ax;
    this.scroller.scrollTop = wy * next - ay;
    this.hooks.onZoom(next);
  }

  private wheel(event: WheelEvent) {
    if (event.ctrlKey) {
      // Ctrl+wheel, and pinching on a touchpad, zoom.
      event.preventDefault();
      this.setZoom(this.zoom * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
    } else if (event.altKey && this.active) {
      // Alt+wheel makes the selected text bigger or smaller, a step per notch.
      event.preventDefault();
      this.wheelSteps += event.deltaY;
      while (Math.abs(this.wheelSteps) >= 50) {
        const view = this.active.view;
        stepSize(this.wheelSteps < 0 ? 1 : -1)(view.state, view.dispatch);
        this.wheelSteps -= Math.sign(this.wheelSteps) * 100;
        if (Math.abs(this.wheelSteps) < 50) this.wheelSteps = 0;
      }
    }
  }

  // ---- tools --------------------------------------------------------------------

  setTool(tool: Tool) {
    pen.tool = tool;
    this.world.dataset.tool = tool;
    if (tool !== "select") this.ink.selected = null;
    if (tool !== "type") {
      this.choose(null);
      // Keys now pick tools rather than type.
      if (this.active?.view.hasFocus()) (document.activeElement as HTMLElement).blur();
    }
    this.ink.draw();
    this.hooks.onTool(tool);
  }

  setPaper(paper: Paper) {
    this.paper = paper;
    this.world.dataset.paper = paper;
    this.changed(true);
  }

  /** Colour or width chosen: the selected drawing takes it too. */
  restyle() {
    if (pen.tool === "select") this.ink.restyle();
  }

  // ---- the mouse ------------------------------------------------------------------

  /** Before anything else sees a press: a stylus writes even while typing, and the select tool pans on empty spots. */
  private capture(event: PointerEvent) {
    const target = event.target as Element;
    if (target.closest(".ink-input, .page-head")) return;
    if (event.pointerType === "pen" && pen.tool === "type" && !target.closest(".box-bar, .box-grip, .picture-handle")) {
      event.stopPropagation();
      this.choose(null);
      this.ink.down(event, "pen");
      return;
    }
    if (pen.tool === "select" && !this.ink.hasItemAt(event)) {
      event.stopPropagation();
      this.ink.selected = null;
      this.ink.draw();
      this.pan(event);
    }
  }

  private down(event: PointerEvent) {
    if (event.target !== this.world || event.button !== 0) return;
    // An empty spot: a click starts a text box there; a drag moves the view.
    event.preventDefault();
    this.choose(null);
    this.spot = this.point(event);
    const start = [event.clientX, event.clientY];
    let panned = false;
    const stopPan = this.pan(event, () => (panned = true));
    const up = (e: PointerEvent) => {
      this.world.removeEventListener("pointerup", up);
      stopPan();
      if (panned || Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 4) return;
      if (this.active && isEmpty(this.active.view)) this.removeBox(this.active, false);
      const [x, y] = this.spot!;
      this.newBox(x, Math.max(y - 12, TOP - 20)).view.focus();
    };
    this.world.addEventListener("pointerup", up);
  }

  /** Moves the view with the pointer until it's let go. Returns a way to stop early. */
  private pan(event: PointerEvent, onMove?: () => void): () => void {
    const startX = event.clientX;
    const startY = event.clientY;
    const left = this.scroller.scrollLeft;
    const top = this.scroller.scrollTop;
    const el = this.world;
    el.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
      this.scroller.classList.add("panning");
      onMove?.();
      this.scroller.scrollLeft = left - (e.clientX - startX);
      this.scroller.scrollTop = top - (e.clientY - startY);
    };
    const stop = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", stop);
      this.scroller.classList.remove("panning");
      if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", stop);
    return stop;
  }

  /** Moving a text box or picture by its edge, or changing its width. */
  dragObject(event: PointerEvent, id: string, kind: "move" | "width") {
    if (event.button !== 0 || pen.tool !== "type") return;
    event.preventDefault();
    event.stopPropagation();
    const thing = this.boxes.get(id) ?? this.pictures.get(id);
    if (!thing) return;
    this.choose(id);
    const before = this.snapshot();
    const startX = event.clientX;
    const startY = event.clientY;
    const { x, y, w } = thing.item;
    const s = this.scale;
    const el = event.currentTarget as HTMLElement;
    el.setPointerCapture(event.pointerId);
    let changed = false;
    const move = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / s;
      const dy = (e.clientY - startY) / s;
      if (!changed && Math.hypot(dx, dy) * s < 3) return;
      changed = true;
      if (kind === "move") {
        thing.item.x = Math.round(Math.max(0, x + dx));
        thing.item.y = Math.round(Math.max(0, y + dy));
      } else thing.item.w = Math.round(Math.max(80, w + dx));
      thing.place();
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      if (!changed) return;
      this.record(before);
      this.changed(true);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }

  /** Marks a picture or text box as picked (Delete removes it). */
  private choose(id: string | null) {
    this.chosen = id;
    for (const el of this.world.querySelectorAll(".chosen")) el.classList.remove("chosen");
    if (id) (this.boxes.get(id) ?? this.pictures.get(id))?.el.classList.add("chosen");
  }

  /** Delete or Backspace outside the text: removes what's picked. */
  removeChosen(): boolean {
    if (this.ink.removeSelected()) return true;
    const id = this.chosen;
    if (!id) return false;
    this.record();
    const box = this.boxes.get(id);
    if (box) this.removeBox(box, false);
    const pic = this.pictures.get(id);
    if (pic) {
      pic.el.remove();
      this.pictures.delete(id);
    }
    this.choose(null);
    this.changed(true);
    return true;
  }

  // ---- text boxes -------------------------------------------------------------------

  private addBox(item: Omit<BoxItem, "doc">, doc: unknown): TextBox {
    const box = new TextBox({ id: item.id, t: "box", x: item.x, y: item.y, w: item.w }, doc, this);
    this.boxes.set(item.id, box);
    this.world.insertBefore(box.el, this.ink.svg);
    this.resize.observe(box.el);
    return box;
  }

  /** A new, empty text box at (x, y). */
  newBox(x: number, y: number): TextBox {
    const box = this.addBox({ t: "box", id: newItemId(), x: Math.round(Math.max(8, x)), y: Math.round(Math.max(8, y)), w: BOX_WIDTH }, null);
    this.fit();
    return box;
  }

  private removeBox(box: TextBox, save = true) {
    this.resize.unobserve(box.el);
    box.view.destroy();
    box.el.remove();
    this.boxes.delete(box.item.id);
    if (this.active === box) {
      this.active = null;
      this.hooks.onActive(null);
    }
    if (save) this.changed(false);
  }

  focused(box: TextBox) {
    this.active = box;
    this.choose(null);
    if (pen.tool !== "type") this.setTool("type");
    this.hooks.onActive(box.view);
  }

  /** A text box lost the cursor: an empty one goes away, as in OneNote. */
  leftBox(box: TextBox) {
    if (this.boxes.get(box.item.id) !== box || box.el.contains(document.activeElement)) return;
    if (isEmpty(box.view)) this.removeBox(box);
    // Table tools and the like only show while writing.
    else if (this.active === box) this.hooks.onActive(null);
  }

  textChanged(view: EditorView, docChanged: boolean) {
    this.hooks.onActive(view);
    if (!docChanged) return;
    this.lastWasCanvas = false;
    this.changed(false);
  }

  // ---- pictures ---------------------------------------------------------------------

  private addPicture(item: PictureItem): Picture {
    const pic = new Picture(item, this);
    this.pictures.set(item.id, pic);
    this.world.insertBefore(pic.el, this.ink.svg);
    return pic;
  }

  /** Where pasted things go: the last spot clicked, or the top left of what's in view. */
  private insertionPoint(): [number, number] {
    if (this.spot) return this.spot;
    return [this.scroller.scrollLeft / this.zoom + LEFT, Math.max(TOP, this.scroller.scrollTop / this.zoom + 40)];
  }

  /** Places pictures on the page at (x, y), one under the other. */
  async placePictures(files: File[], at = this.insertionPoint()) {
    const before = this.snapshot();
    let [x, y] = at;
    const placed: PictureItem[] = [];
    for (const file of files) {
      const src = await savePicture(file);
      const size = await pictureSize(src);
      const w = Math.round(Math.min(size.w, 720));
      placed.push({ t: "picture", id: newItemId(), x: Math.round(x), y: Math.round(y), w, src });
      y += (size.h * w) / size.w + 16;
    }
    if (!placed.length) return;
    this.record(before);
    for (const item of placed) this.addPicture(item);
    this.spot = [x, y];
    this.choose(placed[placed.length - 1].id);
    this.fit();
    this.changed(true);
  }

  /** Pictures pasted while writing: into the text, or, in a box that's still empty, onto the page in its place. */
  async picturesInBox(box: TextBox, files: File[], pos: number | null) {
    try {
      if (isEmpty(box.view)) {
        const at: [number, number] = [box.item.x, box.item.y];
        this.removeBox(box, false);
        await this.placePictures(files, at);
        return;
      }
      const srcs = await Promise.all(files.map((file) => savePicture(file)));
      insertPictures(box.view, srcs, pos);
    } catch (error) {
      console.error("The picture could not be added", error);
    }
  }

  /** Ctrl+V when no text box has the cursor: pictures and text land on the page. */
  async paste(event: ClipboardEvent) {
    const data = event.clipboardData;
    if (!data) return;
    const files = [...data.files].filter((f) => f.type.startsWith("image/"));
    event.preventDefault();
    if (files.length) return this.placePictures(files);
    const html = data.getData("text/html");
    const text = data.getData("text/plain");
    if (!html && !text) return;
    const [x, y] = this.insertionPoint();
    const box = this.newBox(x, y);
    box.view.focus();
    if (html) box.view.pasteHTML(html);
    else box.view.pasteText(text);
  }

  private drop(event: DragEvent) {
    if ((event.target as Element).closest(".ProseMirror")) return;
    const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void this.placePictures(files, this.point(event));
  }

  // ---- undo -----------------------------------------------------------------------

  private snapshot(): Snapshot {
    return {
      boxes: [...this.boxes.values()].map((box) => box.toItem()),
      pictures: [...this.pictures.values()].map((pic) => ({ ...pic.item })),
      ink: this.inkItems,
    };
  }

  /** Remembers how things are, before a change to the canvas, so it can be undone. */
  private record(snapshot = this.snapshot()) {
    this.past.push(snapshot);
    if (this.past.length > 200) this.past.shift();
    this.future = [];
    this.lastWasCanvas = true;
    // Ctrl+Z now undoes this, not the typing before it.
    if (this.active?.view.hasFocus()) (document.activeElement as HTMLElement).blur();
  }

  /** Puts the canvas back as it was. Text boxes that still exist keep their text: typing has its own undo. */
  private restore(snapshot: Snapshot) {
    const keep = new Set(snapshot.boxes.map((b) => b.id));
    for (const box of [...this.boxes.values()]) if (!keep.has(box.item.id)) this.removeBox(box, false);
    for (const item of snapshot.boxes) {
      const box = this.boxes.get(item.id);
      if (box) {
        Object.assign(box.item, { x: item.x, y: item.y, w: item.w });
        box.place();
      } else this.addBox(item, item.doc);
    }
    for (const pic of this.pictures.values()) pic.el.remove();
    this.pictures.clear();
    for (const item of snapshot.pictures) this.addPicture({ ...item });
    this.inkItems = snapshot.ink;
    this.ink.refresh();
    this.choose(null);
    this.fit();
    this.changed(true);
  }

  undo() {
    const view = this.active?.view;
    if (view && !this.lastWasCanvas && undoDepth(view.state)) {
      editorUndo(view.state, view.dispatch);
      return;
    }
    const last = this.past.pop();
    if (!last) {
      if (view) editorUndo(view.state, view.dispatch);
      return;
    }
    this.future.push(this.snapshot());
    this.restore(last);
  }

  redo() {
    const view = this.active?.view;
    const next = this.future.pop();
    if (!next) {
      if (view) editorRedo(view.state, view.dispatch);
      return;
    }
    this.past.push(this.snapshot());
    this.restore(next);
  }

  // ---- saving and searching ----------------------------------------------------------

  private changed(canvas: boolean) {
    if (canvas) this.fit();
    this.hooks.onChange();
  }

  toPage(): PageFile {
    const items: PageItem[] = [
      ...[...this.pictures.values()].map((pic) => pic.item),
      ...[...this.boxes.values()].filter((box) => !isEmpty(box.view)).map((box) => box.toItem()),
      ...this.inkItems,
    ];
    return { ...this.page, title: this.title.value.trim(), paper: this.paper, items };
  }

  /** Marks the searched-for words in every text box and shows the first. */
  search(query: string) {
    for (const box of this.boxes.values()) box.view.dispatch(box.view.state.tr.setMeta(searchKey, query));
    if (query) requestAnimationFrame(() => this.world.querySelector(".search-hit")?.scrollIntoView({ block: "center", inline: "nearest" }));
  }

  /** Puts the cursor at the end of the last text box, or makes the first one. */
  focusText() {
    const last = [...this.boxes.values()].sort((a, b) => a.item.y - b.item.y).pop();
    const box = last ?? this.newBox(LEFT, TOP);
    box.view.dispatch(box.view.state.tr.setSelection(TextSelection.atEnd(box.view.state.doc)));
    box.view.focus();
  }

  destroy() {
    this.resize.disconnect();
    for (const box of this.boxes.values()) box.view.destroy();
    this.scroller.remove();
  }
}

/** A picture's own size, in pixels. */
async function pictureSize(src: string): Promise<{ w: number; h: number }> {
  const img = new Image();
  img.src = await pictureUrl(src);
  await img.decode().catch(() => undefined);
  return { w: img.naturalWidth || 400, h: img.naturalHeight || 300 };
}
