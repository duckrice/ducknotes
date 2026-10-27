// Pages as a Word document (.docx): each page's title, then its text boxes and pictures from top
// to bottom, with headings, lists, checkboxes, tables, tags and text formatting as Word's own.
// Drawings (pen, shapes, arrows) aren't included; a line in the document says so.

import type { PageFile } from "./store";

interface J {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: J[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** A picture ready to go in: PNG, JPEG or GIF bytes and its size in pixels. */
export interface Picture {
  bytes: Uint8Array;
  ext: "png" | "jpeg" | "gif";
  w: number;
  h: number;
}

const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  rels: "http://schemas.openxmlformats.org/package/2006/relationships",
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TAGS: Record<string, string> = { important: "★ ", question: "? ", exam: "E " };
/** About the width of an A4 page's text, in pixels. */
const MAX_WIDTH = 600;

/** A colour as Word writes it (RRGGBB), from #rgb, #rrggbb or rgb(…). */
function hex(color: unknown): string | null {
  const s = String(color ?? "").trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return m[1].toUpperCase();
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m) return (m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toUpperCase();
  m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(s);
  return m ? [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase() : null;
}

class Writer {
  rels: string[] = [];
  media: { name: string; bytes: Uint8Array }[] = [];
  private nextRel = 2;
  private nextPic = 1;
  /** Pictures loaded ahead (by src), as the writer itself doesn't wait. */
  constructor(private pictures: Map<string, Picture | null>) {}

  private rel(type: string, target: string, external = false) {
    const id = `rId${this.nextRel++}`;
    this.rels.push(`<Relationship Id="${id}" Type="${NS.r}/${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ""}/>`);
    return id;
  }

  picture(src: string, width?: number): string {
    const p = this.pictures.get(src);
    if (!p) return "";
    const name = `image${this.nextPic}.${p.ext}`;
    const id = this.nextPic++;
    this.media.push({ name, bytes: p.bytes });
    const rid = this.rel("image", `media/${name}`);
    const w = Math.min(width ?? p.w, MAX_WIDTH);
    const h = (p.h / p.w) * w;
    const [cx, cy] = [Math.round(w * 9525), Math.round(h * 9525)];
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/><a:graphic><a:graphicData uri="${NS.pic}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }

  private run(text: string, marks: J["marks"] = [], extra = ""): string {
    const rPr: string[] = [];
    let link: string | null = null;
    for (const m of marks ?? []) {
      if (m.type === "bold") rPr.push("<w:b/>");
      else if (m.type === "italic") rPr.push("<w:i/>");
      else if (m.type === "underline") rPr.push('<w:u w:val="single"/>');
      else if (m.type === "strike") rPr.push("<w:strike/>");
      else if (m.type === "code") rPr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
      else if (m.type === "color" && hex(m.attrs?.color)) rPr.push(`<w:color w:val="${hex(m.attrs?.color)}"/>`);
      else if (m.type === "highlight" && hex(m.attrs?.color)) rPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hex(m.attrs?.color)}"/>`);
      else if (m.type === "size" && Number(m.attrs?.px) > 0) rPr.push(`<w:sz w:val="${Math.round(Number(m.attrs?.px) * 1.5)}"/>`);
      else if (m.type === "link") link = String(m.attrs?.href ?? "");
    }
    if (link) {
      // A link looks like one: blue and underlined (each property once).
      for (let k = rPr.length - 1; k >= 0; k--) if (/^<w:(color|u) /.test(rPr[k])) rPr.splice(k, 1);
      rPr.push('<w:color w:val="0563C1"/>', '<w:u w:val="single"/>');
    }
    // In Word's order: fonts, bold, italic, strike, colour, size, underline, shading.
    const order = ["rFonts", "b/", "i/", "strike", "color", "sz", "u ", "shd"];
    if (extra) rPr.push(extra);
    rPr.sort((x, y) => order.findIndex((o) => x.startsWith(`<w:${o}`)) - order.findIndex((o) => y.startsWith(`<w:${o}`)));
    const r = `<w:r>${rPr.length ? `<w:rPr>${[...new Set(rPr)].join("")}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
    return link ? `<w:hyperlink r:id="${this.rel("hyperlink", link, true)}">${r}</w:hyperlink>` : r;
  }

  private inline(nodes: J[] = [], strong = false): string {
    return nodes
      .map((n) => {
        if (n.type === "text") return this.run(n.text ?? "", strong ? [...(n.marks ?? []), { type: "bold" }] : n.marks);
        if (n.type === "hard_break") return "<w:r><w:br/></w:r>";
        if (n.type === "math") return this.run(String(n.attrs?.latex ?? ""), n.marks, "<w:i/>");
        if (n.type === "image") return this.picture(String(n.attrs?.src ?? ""), Number(n.attrs?.width) || undefined);
        return "";
      })
      .join("");
  }

  private para(content: string, pPr = ""): string {
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${content}</w:p>`;
  }

  /** Word paragraphs and tables for a block, `level` deep in lists. */
  blocks(nodes: J[] = [], level = 0, quote = false, strong = false): string {
    const out: string[] = [];
    for (const n of nodes) {
      const indent = level ? `<w:ind w:left="${level * 360}" w:hanging="360"/>` : "";
      if (n.type === "paragraph") {
        const tag = TAGS[String(n.attrs?.tag ?? "")];
        out.push(this.para((tag ? this.run(tag, [{ type: "bold" }]) : "") + this.inline(n.content, strong), `${quote ? '<w:pStyle w:val="Quote"/>' : ""}${indent}`));
      } else if (n.type === "heading") out.push(this.para(this.inline(n.content), `<w:pStyle w:val="Heading${Math.min(3, Math.max(1, Number(n.attrs?.level) || 1))}"/>`));
      else if (n.type === "blockquote") out.push(this.blocks(n.content, level, true));
      else if (n.type === "code_block") {
        const lines = (n.content ?? []).map((t) => t.text ?? "").join("").split("\n");
        out.push(this.para(lines.map((l, i) => `${i ? "<w:r><w:br/></w:r>" : ""}${this.run(l, [{ type: "code" }])}`).join(""), '<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>'));
      } else if (n.type === "horizontal_rule") out.push(this.para("", '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>'));
      else if (n.type === "bullet_list" || n.type === "ordered_list") {
        let number = Number(n.attrs?.order) || 1;
        for (const item of n.content ?? []) {
          const checked = item.attrs?.checked;
          const mark = checked === true ? "☑ " : checked === false ? "☐ " : n.type === "ordered_list" ? `${number++}. ` : "• ";
          const [first, ...rest] = item.content ?? [];
          const own = `<w:ind w:left="${(level + 1) * 360}" w:hanging="360"/>`;
          if (first?.type === "paragraph") out.push(this.para(this.run(mark) + this.inline(first.content), own));
          else if (first) out.push(this.para(this.run(mark), own), this.blocks([first], level + 1));
          out.push(this.blocks(rest, level + 1));
        }
      } else if (n.type === "table") {
        const rows = n.content ?? [];
        const columns = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((sum, c) => sum + (Number(c.attrs?.colspan) || 1), 0)));
        const line = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`;
        out.push(
          `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(line).join("")}</w:tblBorders></w:tblPr><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(columns)}</w:tblGrid>` +
            rows
              .map(
                (r) =>
                  `<w:tr>${(r.content ?? [])
                    .map((c) => {
                      const span = Number(c.attrs?.colspan) || 1;
                      const inner = this.blocks(c.content, 0, false, c.type === "table_header") || "<w:p/>";
                      return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}</w:tcPr>${inner}</w:tc>`;
                    })
                    .join("")}</w:tr>`,
              )
              .join("") +
            "</w:tbl>",
          // Word needs a paragraph between a table and what follows.
          "<w:p/>",
        );
      } else if (n.content) out.push(this.blocks(n.content, level, quote));
    }
    return out.join("");
  }
}

/** The pictures the pages show (their src), to load before writing. */
export function picturesIn(pages: PageFile[]): string[] {
  const found = new Set<string>();
  const walk = (n: J) => {
    if (n.type === "image" && n.attrs?.src) found.add(String(n.attrs.src));
    for (const c of n.content ?? []) walk(c);
  };
  for (const page of pages)
    for (const item of page.items) {
      if (item.t === "picture") found.add(item.src);
      else if (item.t === "box" && item.doc) walk(item.doc as J);
    }
  return [...found];
}

/** The pages as a .docx file. */
export function notesToDocx(pages: PageFile[], pictures: Map<string, Picture | null>): Uint8Array {
  const w = new Writer(pictures);
  const body: string[] = [];
  pages.forEach((page, i) => {
    const pageBreak = i ? '<w:pageBreakBefore/>' : "";
    body.push(`<w:p><w:pPr><w:pStyle w:val="Title"/>${pageBreak}</w:pPr>${page.title ? `<w:r><w:t xml:space="preserve">${esc(page.title)}</w:t></w:r>` : ""}</w:p>`);
    // Top to bottom, then left to right, as they're read on the page.
    const items = [...page.items].filter((it) => it.t === "box" || it.t === "picture").sort((a, b) => (a as { y: number }).y - (b as { y: number }).y || (a as { x: number }).x - (b as { x: number }).x);
    for (const item of items) {
      if (item.t === "box") body.push(w.blocks(((item.doc as J | null)?.content ?? []) as J[]));
      else if (item.t === "picture") body.push(`<w:p>${w.picture(item.src, item.w)}</w:p>`);
    }
    if (page.items.some((it) => it.t !== "box" && it.t !== "picture" && it.t !== "audio")) body.push('<w:p><w:r><w:rPr><w:i/><w:color w:val="808080"/></w:rPr><w:t>(This page also has drawings, which aren\'t included here.)</w:t></w:r></w:p>');
  });
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const style = (id: string, name: string, pPr: string, rPr: string) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;
  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="${NS.w}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="nb-NO"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    style("Title", "Title", '<w:spacing w:after="240"/>', '<w:sz w:val="48"/>') +
    style("Heading1", "heading 1", '<w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/>', '<w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/>') +
    style("Heading2", "heading 2", '<w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="1"/>', '<w:b/><w:color w:val="2F5496"/><w:sz w:val="26"/>') +
    style("Heading3", "heading 3", '<w:keepNext/><w:spacing w:before="160" w:after="40"/><w:outlineLvl w:val="2"/>', '<w:b/><w:color w:val="2F5496"/><w:sz w:val="24"/>') +
    style("Quote", "Quote", '<w:ind w:left="567"/>', '<w:i/><w:color w:val="595959"/>') +
    `</w:styles>`;
  const types =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const enc = new TextEncoder();
  return zip([
    ["[Content_Types].xml", enc.encode(types)],
    ["_rels/.rels", enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS.rels}"><Relationship Id="rId1" Type="${NS.r}/officeDocument" Target="word/document.xml"/></Relationships>`)],
    ["word/document.xml", enc.encode(document)],
    ["word/styles.xml", enc.encode(styles)],
    ["word/_rels/document.xml.rels", enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS.rels}"><Relationship Id="rId1" Type="${NS.r}/styles" Target="styles.xml"/>${w.rels.join("")}</Relationships>`)],
    ...w.media.map((m): [string, Uint8Array] => [`word/media/${m.name}`, m.bytes]),
  ]);
}

// ---- a zip file, stored (not compressed): Word reads those fine ------------------------------

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const header = (size: number) => {
      const b = new Uint8Array(size);
      return [b, new DataView(b.buffer)] as const;
    };
    const [local, l] = header(30 + nameBytes.length);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x0800, true); // names in UTF-8
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const [entry, e] = header(46 + nameBytes.length);
    e.setUint32(0, 0x02014b50, true);
    e.setUint16(4, 20, true);
    e.setUint16(6, 20, true);
    e.setUint16(8, 0x0800, true);
    e.setUint32(16, crc, true);
    e.setUint32(20, data.length, true);
    e.setUint32(24, data.length, true);
    e.setUint16(28, nameBytes.length, true);
    e.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    parts.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const d = new DataView(end.buffer);
  d.setUint32(0, 0x06054b50, true);
  d.setUint16(8, files.length, true);
  d.setUint16(10, files.length, true);
  d.setUint32(12, size, true);
  d.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const p of [...parts, ...central, end]) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
