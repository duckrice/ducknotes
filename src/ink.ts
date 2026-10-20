// The drawing layer over the whole page: pen, highlighter and eraser, and
// boxes, circles, diamonds, lines and arrows for diagrams. Arrows drawn
// between shapes stay tied to them when the shapes are moved.

import { h, svg } from "./dom";
import {
  arrowHead,
  bounds,
  hits,
  insideShape,
  isShape,
  lineEnds,
  moved,
  newItemId,
  smoothPath,
  type Item,
  type Line,
  type Shape,
  type ShapeKind,
} from "./geometry";

/** "type" is for writing text; the others draw. */
export type Tool = "type" | "select" | "pen" | "highlighter" | "eraser" | "line" | "arrow" | ShapeKind;

export const COLORS = ["#1f2933", "#dc2626", "#2563eb", "#16a34a", "#ea580c", "#9333ea", "#eab308"];
export const COLOR_NAMES = ["Black", "Red", "Blue", "Green", "Orange", "Purple", "Yellow"];
export const WIDTHS = [2, 4, 8];
const LABEL_SIZE = 18;

/** The tool, colours and width, shared by all pages, as with a real pen. The highlighter has its own colour. */
export const pen = { tool: "type" as Tool, color: COLORS[0], marker: COLORS[6], width: WIDTHS[0] };

export interface InkHost {
  items(): Item[];
  /** Replaces the drawing with `items`, as one step that can be undone. */
  commit(items: Item[]): void;
  /** Where an event is on the page, in page units. */
  point(event: MouseEvent): [number, number];
  zoom(): number;
  /** The element labels are typed in, over the page. */
  world: HTMLElement;
}

type Drag =
  | { kind: "pen"; item: Extract<Item, { t: "pen" }> }
  | { kind: "erase"; gone: Set<string> }
  | { kind: "shape"; item: Shape; x0: number; y0: number }
  | { kind: "line"; item: Line }
  | { kind: "move"; id: string; x0: number; y0: number; dx: number; dy: number }
  | { kind: "resize"; id: string; box: Shape };

export class InkLayer {
  svg: SVGSVGElement;
  private layer: SVGGElement;
  selected: string | null = null;
  private drag: Drag | null = null;
  private editing: { box: HTMLTextAreaElement; finish: () => void } | null = null;

  constructor(private host: InkHost) {
    this.svg = svg("svg", { class: "ink", "aria-hidden": "true" });
    this.layer = svg("g");
    this.svg.append(this.layer);
    this.svg.addEventListener("pointerdown", (event) => this.down(event));
    this.svg.addEventListener("pointermove", (event) => this.move(event));
    this.svg.addEventListener("pointerup", (event) => this.up(event));
    this.svg.addEventListener("pointercancel", (event) => this.up(event));
    this.svg.addEventListener("dblclick", (event) => this.doubleClick(event));
  }

  private get items(): Item[] {
    return this.host.items();
  }

  // ---- showing --------------------------------------------------------------

  draw(preview?: Item[], faded?: Set<string>) {
    const items = preview ?? this.items;
    const byId = new Map(items.map((item) => [item.id, item]));
    this.layer.replaceChildren(...items.map((item) => this.shapeFor(item, byId, faded?.has(item.id))));
    const chosen = this.selected && byId.get(this.selected);
    if (pen.tool === "select" && chosen && !this.editing) {
      const b = bounds(chosen, byId);
      this.layer.append(svg("rect", { class: "ink-selection", x: b.x - 6, y: b.y - 6, width: b.w + 12, height: b.h + 12, rx: 4 }));
      if (isShape(chosen)) this.layer.append(svg("rect", { class: "ink-handle", x: chosen.x + chosen.w - 5, y: chosen.y + chosen.h - 5, width: 10, height: 10, rx: 2 }));
    }
  }

  private shapeFor(item: Item, byId: Map<string, Item>, faded = false): SVGElement {
    const g = svg("g", { opacity: faded ? 0.2 : 1, "data-id": item.id });
    const stroke = { stroke: item.c, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
    switch (item.t) {
      case "pen":
        g.append(svg("path", { ...stroke, d: smoothPath(item.pts), "stroke-width": item.hl ? item.w * 5 : item.w, ...(item.hl ? { opacity: 0.35 } : {}) }));
        break;
      case "line":
      case "arrow": {
        const [x1, y1, x2, y2] = lineEnds(item, byId);
        g.append(svg("line", { ...stroke, x1, y1, x2, y2, "stroke-width": item.w }));
        if (item.t === "arrow") g.append(svg("polygon", { points: arrowHead(x1, y1, x2, y2, item.w), fill: item.c, stroke: item.c, "stroke-width": 1, "stroke-linejoin": "round" }));
        break;
      }
      default: {
        const outline = { stroke: item.c, fill: "#ffffff", "stroke-width": 2 };
        if (item.t === "rect") g.append(svg("rect", { ...outline, x: item.x, y: item.y, width: item.w, height: item.h, rx: 8 }));
        else if (item.t === "ellipse") g.append(svg("ellipse", { ...outline, cx: item.x + item.w / 2, cy: item.y + item.h / 2, rx: item.w / 2, ry: item.h / 2 }));
        else {
          const cx = item.x + item.w / 2;
          const cy = item.y + item.h / 2;
          g.append(svg("polygon", { ...outline, "stroke-linejoin": "round", points: `${cx},${item.y} ${item.x + item.w},${cy} ${cx},${item.y + item.h} ${item.x},${cy}` }));
        }
        if (item.label) {
          const lines = item.label.split("\n");
          const text = svg("text", { x: item.x + item.w / 2, "font-size": LABEL_SIZE, fill: "#1f2933", "text-anchor": "middle", class: "ink-text" });
          const top = item.y + item.h / 2 - (lines.length * LABEL_SIZE * 1.25) / 2;
          lines.forEach((line, i) => {
            const span = svg("tspan", { x: item.x + item.w / 2, y: top + LABEL_SIZE * (0.95 + i * 1.25) });
            span.textContent = line || " ";
            text.append(span);
          });
          g.append(text);
        }
      }
    }
    return g;
  }

  // ---- the mouse, pen and finger ---------------------------------------------

  private get tolerance(): number {
    return 6 / this.host.zoom();
  }

  private itemAt(x: number, y: number, items = this.items): Item | undefined {
    const byId = new Map(items.map((item) => [item.id, item]));
    for (let i = items.length - 1; i >= 0; i--) if (hits(items[i], x, y, this.tolerance, byId)) return items[i];
    return undefined;
  }

  private shapeAt(x: number, y: number): Shape | undefined {
    return [...this.items].reverse().find((item): item is Shape => isShape(item) && insideShape(item, x, y));
  }

  /** Whether the select tool would pick something up here. */
  hasItemAt(event: MouseEvent): boolean {
    const [x, y] = this.host.point(event);
    return !!this.itemAt(x, y);
  }

  /** Starts drawing; `tool` overrides the chosen one (a stylus writes even while typing). */
  down(event: PointerEvent, tool: Tool = pen.tool) {
    if (event.button !== 0 && event.button !== 5) return;
    if (this.editing) {
      this.editing.finish();
      return;
    }
    event.preventDefault();
    const [x, y] = this.host.point(event);
    // The eraser end of a pen, or its eraser button, rubs out whatever the tool.
    if (event.buttons & 32) tool = "eraser";
    const { color: c, width: w } = pen;

    switch (tool) {
      case "pen":
      case "highlighter":
        this.drag = { kind: "pen", item: { t: "pen", id: newItemId(), c: tool === "highlighter" ? pen.marker : c, w, pts: [x, y], ...(tool === "highlighter" ? { hl: true } : {}) } };
        break;
      case "eraser":
        this.drag = { kind: "erase", gone: new Set() };
        this.erase(x, y);
        break;
      case "line":
      case "arrow": {
        const from = this.shapeAt(x, y);
        this.drag = { kind: "line", item: { t: tool, id: newItemId(), c, w, x1: x, y1: y, x2: x, y2: y, ...(from ? { from: from.id } : {}) } };
        break;
      }
      case "rect":
      case "ellipse":
      case "diamond":
        this.drag = { kind: "shape", x0: x, y0: y, item: { t: tool, id: newItemId(), c, x, y, w: 0, h: 0 } };
        break;
      case "select": {
        const chosen = this.items.find((item) => item.id === this.selected);
        const near = 1.5 * this.tolerance;
        if (isShape(chosen) && Math.abs(x - (chosen.x + chosen.w)) <= near && Math.abs(y - (chosen.y + chosen.h)) <= near) {
          this.drag = { kind: "resize", id: chosen.id, box: chosen };
          break;
        }
        const hit = this.itemAt(x, y);
        this.selected = hit?.id ?? null;
        if (hit) this.drag = { kind: "move", id: hit.id, x0: x, y0: y, dx: 0, dy: 0 };
        this.draw();
        break;
      }
      default:
        return;
    }
    if (this.drag) (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }

  move(event: PointerEvent) {
    const drag = this.drag;
    if (!drag) return;
    const [x, y] = this.host.point(event);
    switch (drag.kind) {
      case "pen":
        // Every sample the pen gave since the last event, for smooth lines.
        for (const e of event.getCoalescedEvents?.() ?? [event]) drag.item.pts.push(...this.host.point(e));
        this.draw([...this.items, drag.item]);
        break;
      case "erase":
        this.erase(x, y);
        break;
      case "line": {
        const to = this.shapeAt(x, y);
        drag.item = { ...drag.item, x2: x, y2: y, to: to && to.id !== drag.item.from ? to.id : undefined };
        this.draw([...this.items, drag.item]);
        break;
      }
      case "shape": {
        // Shift makes a square or circle.
        let w = x - drag.x0;
        let h = y - drag.y0;
        if (event.shiftKey) w = h = Math.sign(w || 1) * Math.max(Math.abs(w), Math.abs(h));
        drag.item = { ...drag.item, x: Math.min(drag.x0, drag.x0 + w), y: Math.min(drag.y0, drag.y0 + h), w: Math.abs(w), h: Math.abs(h) };
        this.draw([...this.items, drag.item]);
        break;
      }
      case "move": {
        drag.dx = x - drag.x0;
        drag.dy = y - drag.y0;
        const byId = new Map(this.items.map((item) => [item.id, item]));
        this.draw(this.items.map((item) => (item.id === drag.id ? moved(item, drag.dx, drag.dy, byId) : item)));
        break;
      }
      case "resize":
        this.draw(this.items.map((item) => (item.id === drag.id ? { ...drag.box, w: Math.max(16, x - drag.box.x), h: Math.max(16, y - drag.box.y) } : item)));
        break;
    }
  }

  up(event: PointerEvent) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    const target = event.currentTarget as Element;
    if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
    const [x, y] = this.host.point(event);
    switch (drag.kind) {
      case "pen":
        this.host.commit([...this.items, drag.item]);
        break;
      case "erase":
        if (drag.gone.size) this.host.commit(this.items.filter((item) => !drag.gone.has(item.id)));
        else this.draw();
        break;
      case "line": {
        const { item } = drag;
        // A click without a drag draws nothing.
        if (Math.hypot(item.x2 - item.x1, item.y2 - item.y1) < 4 && !(item.from && item.to)) this.draw();
        else this.host.commit([...this.items, item]);
        break;
      }
      case "shape": {
        // A click without a drag makes a shape of the usual size, ready for its words.
        const item = drag.item.w < 8 && drag.item.h < 8 ? { ...drag.item, x: x - 70, y: y - 35, w: 140, h: 70 } : drag.item;
        this.host.commit([...this.items, item]);
        this.editLabel(item);
        break;
      }
      case "move": {
        if (!drag.dx && !drag.dy) break;
        const byId = new Map(this.items.map((item) => [item.id, item]));
        this.host.commit(this.items.map((item) => (item.id === drag.id ? moved(item, drag.dx, drag.dy, byId) : item)));
        break;
      }
      case "resize":
        this.host.commit(this.items.map((item) => (item.id === drag.id ? { ...drag.box, w: Math.max(16, x - drag.box.x), h: Math.max(16, y - drag.box.y) } : item)));
        break;
    }
  }

  get drawing(): boolean {
    return !!this.drag;
  }

  private erase(x: number, y: number) {
    const drag = this.drag;
    if (drag?.kind !== "erase") return;
    const hit = this.itemAt(x, y, this.items.filter((item) => !drag.gone.has(item.id)));
    if (hit) drag.gone.add(hit.id);
    this.draw(undefined, drag.gone);
  }

  private doubleClick(event: MouseEvent) {
    if (pen.tool === "pen" || pen.tool === "highlighter" || pen.tool === "eraser") return;
    const [x, y] = this.host.point(event);
    const hit = this.itemAt(x, y);
    if (isShape(hit)) this.editLabel(hit);
  }

  /** Removes what the select tool picked. */
  removeSelected(): boolean {
    const id = this.selected;
    if (!id) return false;
    this.selected = null;
    // Arrows tied to a removed shape stay where they were.
    const byId = new Map(this.items.map((item) => [item.id, item]));
    this.host.commit(
      this.items
        .filter((item) => item.id !== id)
        .map((item) => {
          if ((item.t !== "line" && item.t !== "arrow") || (item.from !== id && item.to !== id)) return item;
          const [x1, y1, x2, y2] = lineEnds(item, byId);
          return { ...item, x1, y1, x2, y2, from: item.from === id ? undefined : item.from, to: item.to === id ? undefined : item.to };
        }),
    );
    return true;
  }

  /** Gives the selected item the chosen colour or width. */
  restyle() {
    const chosen = this.items.find((item) => item.id === this.selected);
    if (!chosen) return;
    const width = chosen.t === "pen" || chosen.t === "line" || chosen.t === "arrow" ? { w: pen.width } : {};
    this.host.commit(this.items.map((item) => (item.id === chosen.id ? ({ ...item, c: pen.color, ...width } as Item) : item)));
  }

  /** Writes the words inside a box, circle or diamond, in a box over the page. */
  editLabel(shape: Shape) {
    this.editing?.finish();
    const box = h("textarea", { class: "ink-input", rows: 1, spellcheck: "false", "aria-label": "Words in the shape" });
    box.value = shape.label ?? "";
    box.style.left = `${shape.x}px`;
    box.style.top = `${shape.y + shape.h / 2 - LABEL_SIZE * 0.7}px`;
    box.style.width = `${shape.w}px`;
    box.style.fontSize = `${LABEL_SIZE}px`;
    const fit = () => {
      box.style.height = "auto";
      box.style.height = `${box.scrollHeight}px`;
    };
    const finish = () => {
      if (this.editing?.box !== box) return;
      this.editing = null;
      box.remove();
      const label = box.value.replace(/\s+$/, "");
      const current = this.items.find((other) => other.id === shape.id);
      if (current && isShape(current) && (current.label ?? "") !== label) this.host.commit(this.items.map((item) => (item.id === shape.id ? { ...current, label: label || undefined } : item)));
      else this.draw();
    };
    box.addEventListener("input", fit);
    box.addEventListener("blur", finish);
    box.addEventListener("keydown", (event) => {
      event.stopPropagation();
      // Enter finishes; Shift+Enter starts a new line.
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Escape") {
        event.preventDefault();
        finish();
      }
    });
    this.editing = { box, finish };
    this.host.world.append(box);
    this.draw();
    fit();
    box.focus();
    box.select();
  }

  /** Called when the drawing changed from outside (undo, another page). */
  refresh() {
    if (this.selected && !this.items.some((item) => item.id === this.selected)) this.selected = null;
    if (!this.drag) this.draw();
  }
}
