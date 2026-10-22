import { describe, expect, it } from "vitest";
import { EditorView } from "prosemirror-view";
import { AllSelection, TextSelection } from "prosemirror-state";
import { arrowHead, edgePoint, hits, lineEnds, moved, movedTogether, smoothPath, type Item, type Shape } from "../src/geometry";
import { newPageFile, pageText, safeName } from "../src/store";
import { createState, insertTable, tagAt, toggleTag, normaliseUrl, sizeAt, stepSize, toggleCheck, toggleList } from "../src/editor";
import { emptyDoc, schema } from "../src/schema";

describe("drawing geometry", () => {
  const box: Shape = { t: "rect", id: "a", c: "#000", x: 100, y: 100, w: 100, h: 50 };
  const circle: Shape = { t: "ellipse", id: "b", c: "#000", x: 400, y: 100, w: 100, h: 50 };

  it("finds where a line leaves a shape", () => {
    expect(edgePoint(box, 400, 125)).toEqual([200, 125]);
    expect(edgePoint(box, 150, 0)).toEqual([150, 100]);
    expect(edgePoint(circle, 0, 125)).toEqual([400, 125]);
    const [x, y] = edgePoint({ ...box, t: "diamond" }, 300, 225);
    expect(Math.abs(x - 150) / 50 + Math.abs(y - 125) / 25).toBeCloseTo(1);
  });

  it("keeps arrows tied to the shapes they join", () => {
    const arrow: Item = { t: "arrow", id: "c", c: "#000", w: 2, x1: 0, y1: 0, x2: 0, y2: 0, from: "a", to: "b" };
    const byId = new Map<string, Item>([["a", box], ["b", circle], ["c", arrow]]);
    expect(lineEnds(arrow, byId)).toEqual([200, 125, 400, 125]);
    // The box moves; the arrow follows.
    byId.set("a", moved(box, 0, 100, byId));
    const [x1, y1] = lineEnds(arrow, byId);
    expect(y1).toBeGreaterThan(125);
    expect(x1).toBeGreaterThan(150);
    // Moving the arrow itself lets go of the shapes.
    const loose = moved(arrow, 10, 0, byId) as Extract<Item, { t: "arrow" }>;
    expect(loose.from).toBeUndefined();
    expect(loose.to).toBeUndefined();
  });

  it("knows what a click lands on", () => {
    const pen: Item = { t: "pen", id: "p", c: "#000", w: 2, pts: [0, 0, 100, 0] };
    const byId = new Map<string, Item>();
    expect(hits(pen, 50, 3, 2, byId)).toBe(true);
    expect(hits(pen, 50, 20, 2, byId)).toBe(false);
    expect(hits(box, 150, 125, 0, byId)).toBe(true);
    expect(hits(circle, 401, 101, 0, byId)).toBe(false);
  });

  it("draws smooth strokes and arrowheads", () => {
    expect(smoothPath([1, 2])).toBe("M1 2l0.01 0");
    expect(smoothPath([0, 0, 10, 0, 20, 10, 30, 10])).toBe("M0 0Q10 0 15 5Q20 10 25 10L30 10");
    expect(arrowHead(0, 0, 100, 0, 2).split(" ")[0]).toBe("100,0");
  });
});

describe("storage", () => {
  it("makes names Windows accepts", () => {
    expect(safeName("Maths: week 1/2")).toBe("Maths week 1 2");
    expect(safeName("  .hidden. ")).toBe("hidden");
    expect(safeName("CON")).toBe("CON notes");
    expect(safeName("???")).toBe("Notebook");
  });

  it("finds the words on a page, in equations and shapes too", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Newton" }, { type: "math", attrs: { latex: "F=ma" } }] }] };
    const items = [
      { t: "box" as const, id: "1", x: 0, y: 0, w: 100, doc },
      { t: "rect" as const, id: "2", c: "#000", x: 0, y: 0, w: 10, h: 10, label: "Force" },
      { t: "picture" as const, id: "3", x: 0, y: 0, w: 10, src: ".media/a.png" },
    ];
    expect(pageText("Physics", items)).toBe("Physics Newton F=ma Force");
  });

  it("names pages by time", () => {
    expect(newPageFile(new Date(2026, 9, 20, 14, 5, 9))).toMatch(/^20261020-140509-[a-z0-9]+\.json$/);
  });

  it("fills in web and e-mail addresses", () => {
    expect(normaliseUrl("duck.no")).toBe("https://duck.no");
    expect(normaliseUrl("http://x.org")).toBe("http://x.org");
    expect(normaliseUrl("me@duck.no")).toBe("mailto:me@duck.no");
    expect(normaliseUrl("  ")).toBeNull();
  });
});

describe("typing", () => {
  function editor() {
    const host = document.createElement("div");
    document.body.append(host);
    return new EditorView(host, { state: createState(emptyDoc()) });
  }

  function type(view: EditorView, text: string) {
    for (const ch of text) {
      const { from, to } = view.state.selection;
      if (!view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)))) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
  }

  const first = (view: EditorView) => view.state.doc.firstChild!;

  it("turns # into a heading", () => {
    const view = editor();
    type(view, "## Week 3");
    expect(first(view).type.name).toBe("heading");
    expect(first(view).attrs.level).toBe(2);
    expect(first(view).textContent).toBe("Week 3");
  });

  it("turns - and 1. into lists", () => {
    const view = editor();
    type(view, "- idea");
    expect(first(view).type.name).toBe("bullet_list");
    const numbered = editor();
    type(numbered, "1. step");
    expect(first(numbered).type.name).toBe("ordered_list");
  });

  it("turns [] and [x] into checkboxes", () => {
    const view = editor();
    type(view, "[] read chapter 4");
    expect(first(view).type.name).toBe("bullet_list");
    expect(first(view).firstChild!.attrs.checked).toBe(false);
    expect(first(view).textContent).toBe("read chapter 4");
    const done = editor();
    type(done, "[x] done");
    expect(first(done).firstChild!.attrs.checked).toBe(true);
    // Inside a checklist, [x] ticks the new item.
    view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: "Enter" })));
    type(view, "[x] also done");
    expect(first(view).childCount).toBe(2);
    expect(first(view).lastChild!.attrs.checked).toBe(true);
    expect(first(view).lastChild!.textContent).toBe("also done");
  });

  it("ticks and unticks with Ctrl+1", () => {
    const view = editor();
    type(view, "milk");
    toggleCheck(view.state, view.dispatch);
    expect(first(view).firstChild!.attrs.checked).toBe(false);
    toggleCheck(view.state, view.dispatch);
    expect(first(view).firstChild!.attrs.checked).toBe(true);
    // Bullets again: the box goes.
    toggleList("bullet")(view.state, view.dispatch);
    expect(first(view).firstChild!.attrs.checked).toBeNull();
  });

  it("turns $…$ into an equation and -> into an arrow", () => {
    const view = editor();
    type(view, "so $x^2$ -> y");
    const kinds: string[] = [];
    first(view).forEach((node) => kinds.push(node.type.name));
    expect(kinds).toContain("math");
    expect(first(view).textContent).toContain("→ y");
    let latex = "";
    view.state.doc.descendants((node) => {
      if (node.type.name === "math") latex = node.attrs.latex;
    });
    expect(latex).toBe("x^2");
  });

  it("makes text bigger and smaller a step at a time", () => {
    const view = editor();
    type(view, "big");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 4)));
    expect(sizeAt(view.state)).toBe(15);
    stepSize(1)(view.state, view.dispatch);
    stepSize(1)(view.state, view.dispatch);
    expect(sizeAt(view.state)).toBe(18);
    stepSize(-1)(view.state, view.dispatch);
    expect(sizeAt(view.state)).toBe(16);
  });

  it("puts a table in with the cursor in its first cell", () => {
    const view = editor();
    insertTable(2, 3)(view.state, view.dispatch, view);
    const table = view.state.doc.firstChild!;
    expect(table.type.name).toBe("table");
    expect(table.childCount).toBe(2);
    expect(table.firstChild!.childCount).toBe(3);
    expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(view.state.selection.$from.node(-1).type.name).toBe("table_header");
  });

  it("saves and reads back every kind of content", () => {
    const doc = schema.node("doc", null, [
      schema.node("heading", { level: 1 }, [schema.text("Title")]),
      schema.node("bullet_list", null, [schema.node("list_item", { checked: true }, [schema.node("paragraph", null, [schema.text("done")])])]),
      schema.node("image", { src: ".media/x.png", width: 300 }),
      schema.node("paragraph", null, [schema.text("E = "), schema.node("math", { latex: "mc^2" }), schema.text("hi", [schema.marks.highlight.create({ color: "#bbf7d0" })])]),
    ]);
    const back = schema.nodeFromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(back.eq(doc)).toBe(true);
  });
});

describe("picking several things", () => {
  it("moves things together, keeping arrows tied to shapes that move with them", () => {
    const items: Item[] = [
      { t: "rect", id: "a", c: "#000", x: 0, y: 0, w: 100, h: 50 },
      { t: "rect", id: "b", c: "#000", x: 300, y: 0, w: 100, h: 50 },
      { t: "arrow", id: "ab", c: "#000", w: 2, x1: 0, y1: 0, x2: 0, y2: 0, from: "a", to: "b" },
    ];
    const both = movedTogether(items, new Set(["a", "ab"]), 10, 20);
    expect(both[0]).toMatchObject({ x: 10, y: 20 });
    expect(both[1]).toBe(items[1]);
    // Tied to the shape that moved with it; let go of the one left behind.
    expect(both[2]).toMatchObject({ from: "a", to: undefined });
  });
});

describe("tags", () => {
  it("tag lines (the same tag again takes it off), and are found by searching #tag", () => {
    let state = createState(schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Mitosis has four phases")])]));
    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)));
    toggleTag("important")(state, (tr) => (state = state.apply(tr)));
    expect(state.doc.firstChild!.attrs.tag).toBe("important");
    expect(tagAt(state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3))))).toBe("important");
    const text = pageText("Biology", [{ t: "box", id: "b", x: 0, y: 0, w: 100, doc: state.doc.toJSON() }]);
    expect(text).toContain("#important Mitosis has four phases");
    toggleTag("important")(state, (tr) => (state = state.apply(tr)));
    expect(state.doc.firstChild!.attrs.tag).toBe(null);
  });
});
