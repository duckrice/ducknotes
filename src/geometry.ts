// The shapes in a drawing and the sums behind them: smoothing pen strokes,
// finding what was clicked, and where an arrow meets the box it points at.

/** Drawings are WIDTH units wide and scale to the page; their height is kept in the same units. */
export const WIDTH = 800;

export type ShapeKind = "rect" | "ellipse" | "diamond";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Item =
  | { t: "pen"; id: string; c: string; w: number; hl?: boolean; pts: number[] }
  | ({ t: ShapeKind; id: string; c: string; label?: string } & Box)
  /** A line or arrow; `from` and `to` tie its ends to shapes, so it follows them. */
  | { t: "line" | "arrow"; id: string; c: string; w: number; x1: number; y1: number; x2: number; y2: number; from?: string; to?: string };

export type Shape = Extract<Item, { t: ShapeKind }>;
export type Line = Extract<Item, { t: "line" | "arrow" }>;

export const isShape = (item: Item | undefined): item is Shape => !!item && (item.t === "rect" || item.t === "ellipse" || item.t === "diamond");

export const newItemId = () => Math.random().toString(36).slice(2, 9);

const round = (n: number) => Math.round(n * 10) / 10;

/** A pen stroke as a smooth SVG path: curves through the midpoints between samples. */
export function smoothPath(pts: number[]): string {
  if (pts.length < 2) return "";
  const p = (i: number) => `${round(pts[i])} ${round(pts[i + 1])}`;
  if (pts.length === 2) return `M${p(0)}l0.01 0`;
  let d = `M${p(0)}`;
  for (let i = 2; i < pts.length - 2; i += 2) {
    const mx = (pts[i] + pts[i + 2]) / 2;
    const my = (pts[i + 1] + pts[i + 3]) / 2;
    d += `Q${p(i)} ${round(mx)} ${round(my)}`;
  }
  return `${d}L${p(pts.length - 2)}`;
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Where the line from a shape's centre towards (tx, ty) leaves the shape. */
export function edgePoint(shape: Shape, tx: number, ty: number): [number, number] {
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const hw = Math.max(shape.w / 2, 1);
  const hh = Math.max(shape.h / 2, 1);
  if (!dx && !dy) return [cx, cy];
  let t: number;
  if (shape.t === "ellipse") t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  else if (shape.t === "diamond") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return [cx + dx * t, cy + dy * t];
}

/** The two ends of a line as drawn: ends tied to a shape sit on its edge, facing the other end. */
export function lineEnds(line: Line, byId: Map<string, Item>): [number, number, number, number] {
  const from = byId.get(line.from ?? "");
  const to = byId.get(line.to ?? "");
  const centre = (item: Item | undefined, x: number, y: number): [number, number] => (isShape(item) ? [item.x + item.w / 2, item.y + item.h / 2] : [x, y]);
  const [ax, ay] = centre(from, line.x1, line.y1);
  const [bx, by] = centre(to, line.x2, line.y2);
  const [x1, y1] = isShape(from) ? edgePoint(from, bx, by) : [ax, ay];
  const [x2, y2] = isShape(to) ? edgePoint(to, ax, ay) : [bx, by];
  return [x1, y1, x2, y2];
}

export function insideShape(shape: Shape, x: number, y: number, margin = 0): boolean {
  const hw = shape.w / 2 + margin;
  const hh = shape.h / 2 + margin;
  const dx = Math.abs(x - (shape.x + shape.w / 2));
  const dy = Math.abs(y - (shape.y + shape.h / 2));
  if (shape.t === "ellipse") return (dx * dx) / (hw * hw) + (dy * dy) / (hh * hh) <= 1;
  if (shape.t === "diamond") return dx / hw + dy / hh <= 1;
  return dx <= hw && dy <= hh;
}


export function bounds(item: Item, byId: Map<string, Item>): Box {
  switch (item.t) {
    case "pen": {
      const xs = item.pts.filter((_, i) => i % 2 === 0);
      const ys = item.pts.filter((_, i) => i % 2 === 1);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case "line":
    case "arrow": {
      const [x1, y1, x2, y2] = lineEnds(item, byId);
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    }
    default:
      return { x: item.x, y: item.y, w: item.w, h: item.h };
  }
}

/** Whether (x, y) is on the item, give or take `tolerance`. */
export function hits(item: Item, x: number, y: number, tolerance: number, byId: Map<string, Item>): boolean {
  switch (item.t) {
    case "pen": {
      const reach = tolerance + item.w / 2;
      for (let i = 0; i + 1 < item.pts.length; i += 2) {
        const j = Math.min(i + 2, item.pts.length - 2);
        if (distToSegment(x, y, item.pts[i], item.pts[i + 1], item.pts[j], item.pts[j + 1]) <= reach) return true;
      }
      return false;
    }
    case "line":
    case "arrow": {
      const [x1, y1, x2, y2] = lineEnds(item, byId);
      return distToSegment(x, y, x1, y1, x2, y2) <= tolerance + item.w / 2;
    }
    default:
      return insideShape(item, x, y, tolerance);
  }
}

/** The item moved by (dx, dy). A line moved on its own lets go of the shapes it was tied to. */
export function moved(item: Item, dx: number, dy: number, byId: Map<string, Item>): Item {
  switch (item.t) {
    case "pen":
      return { ...item, pts: item.pts.map((v, i) => round(v + (i % 2 ? dy : dx))) };
    case "line":
    case "arrow": {
      const [x1, y1, x2, y2] = lineEnds(item, byId);
      return { ...item, x1: x1 + dx, y1: y1 + dy, x2: x2 + dx, y2: y2 + dy, from: undefined, to: undefined };
    }
    default:
      return { ...item, x: item.x + dx, y: item.y + dy };
  }
}

/** Items moved together by (dx, dy). Lines keep their ties to shapes that move with them. */
export function movedTogether(items: Item[], ids: Set<string>, dx: number, dy: number): Item[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return items.map((item) => {
    if (!ids.has(item.id)) return item;
    const next = moved(item, dx, dy, byId);
    if ((item.t !== "line" && item.t !== "arrow") || (next.t !== "line" && next.t !== "arrow")) return next;
    const keep = (id?: string) => (id && ids.has(id) ? id : undefined);
    return { ...next, from: keep(item.from), to: keep(item.to) };
  });
}

/** The arrowhead at the end of a line from (x1, y1) to (x2, y2), as polygon points. */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, width: number): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = 9 + width * 2.5;
  const spread = 0.45;
  const a = [x2 - size * Math.cos(angle - spread), y2 - size * Math.sin(angle - spread)];
  const b = [x2 - size * Math.cos(angle + spread), y2 - size * Math.sin(angle + spread)];
  return [[x2, y2], a, b].map(([px, py]) => `${round(px)},${round(py)}`).join(" ");
}
