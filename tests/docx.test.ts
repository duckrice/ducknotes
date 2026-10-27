import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { notesToDocx, picturesIn, type Picture } from "../src/docx";
import type { PageFile } from "../src/store";

const text = (t: string, marks?: object[]) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const p = (...content: object[]) => ({ type: "paragraph", content });
// A 1 × 1 PNG.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

const page = (title: string, y = 0): PageFile => ({
  title,
  created: 0,
  modified: 0,
  paper: "plain" as PageFile["paper"],
  items: [
    { t: "picture", id: "p", x: 40, y: y + 400, w: 200, src: ".media/cell.png" },
    {
      t: "box",
      id: "b",
      x: 40,
      y,
      w: 500,
      doc: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [text("Cells")] },
          p(text("The cell is the "), text("unit", [{ type: "bold" }]), text(" of life, see "), text("this", [{ type: "link", attrs: { href: "https://example.com" } }])),
          { type: "paragraph", attrs: { tag: "question" }, content: [text("What makes ATP?")] },
          { type: "bullet_list", content: [{ type: "list_item", attrs: { checked: false }, content: [p(text("Read chapter 4"))] }, { type: "list_item", attrs: { checked: true }, content: [p(text("Ask about mitosis"))] }] },
          { type: "table", content: [{ type: "table_row", content: [{ type: "table_header", content: [p(text("Part"))] }, { type: "table_header", content: [p(text("Job"))] }] }, { type: "table_row", content: [{ type: "table_cell", content: [p(text("Nucleus"))] }, { type: "table_cell", content: [p(text("Control"))] }] }] },
        ],
      },
    },
    { t: "pen", id: "i", c: "#000", w: 2, pts: [0, 0, 10, 10] },
  ] as PageFile["items"],
});

const pictures = new Map<string, Picture | null>([[".media/cell.png", { bytes: PNG, ext: "png", w: 1, h: 1 }]]);

describe("Save as Word document", () => {
  it("finds the pictures to load", () => {
    expect(picturesIn([page("Biology")])).toEqual([".media/cell.png"]);
  });

  it("writes headings, tags, checkboxes, tables and pictures as Word's own", () => {
    const bytes = notesToDocx([page("Biology")], pictures);
    const raw = new TextDecoder("latin1").decode(bytes);
    expect(raw.startsWith("PK")).toBe(true);
    for (const part of ['<w:pStyle w:val="Heading1"/>', "What makes ATP?", "☐", "☑", "<w:tbl>", 'r:embed="rId', "word/media/image1.png", "TargetMode=\"External\"", "drawings, which aren"]) expect(raw.includes(part) || new TextDecoder().decode(bytes).includes(part), part).toBe(true);
  });
});

const word = process.env.WORD_CHECK ? describe : describe.skip;

word("in the real Word", () => {
  it("opens without repair, with the text, the table, the picture and a page per note page", () => {
    const dir = mkdtempSync(join(tmpdir(), "ducknotes-docx-"));
    const file = join(dir, "notes.docx");
    writeFileSync(file, notesToDocx([page("Biology"), page("Chemistry")], pictures));
    const script = join(dir, "check.ps1");
    writeFileSync(
      script,
      `$ErrorActionPreference = 'Stop'
$w = New-Object -ComObject Word.Application
$w.Visible = $false
try {
  $d = $w.Documents.Open('${file}', $false, $true, $false)
  "$($d.Tables.Count)|$($d.InlineShapes.Count)|$($d.ComputeStatistics(2))|$($d.Paragraphs(1).Range.Text.Trim())|$($d.Paragraphs(2).Style.NameLocal)|$($d.Hyperlinks.Count)"
  $d.Close(0)
} finally { $w.Quit() }`,
    );
    const out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8" }).trim();
    const [tables, shapes, pages, title, style, links] = out.split("|");
    expect([tables, shapes, Number(pages) >= 2, title, /1/.test(style), links]).toEqual(["2", "2", true, "Biology", true, "2"]);
  }, 120_000);
});
