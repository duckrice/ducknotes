// Where the notes live: Documents\DuckNotes. Each notebook is a folder, each
// page a .json file in it, and pictures sit in .media. Deleting moves things
// into .trash, so nothing is lost by a wrong click.

import { invoke } from "@tauri-apps/api/core";
import type { Item } from "./geometry";

/** The background of a page: blank, ruled lines, or squares. */
export type Paper = "plain" | "lines" | "grid";
/** A text box on the page, holding its text as ProseMirror JSON. */
export type BoxItem = { t: "box"; id: string; x: number; y: number; w: number; doc: unknown };
/** A picture placed on the page. */
export type PictureItem = { t: "picture"; id: string; x: number; y: number; w: number; src: string };
/** Everything on a page: text boxes, pictures, and ink and shapes (drawn on top). */
export type PageItem = BoxItem | PictureItem | Item;

export interface PageFile {
  title: string;
  /** When the page was made and last changed, in milliseconds. */
  created: number;
  modified: number;
  paper: Paper;
  items: PageItem[];
}

export interface PageInfo {
  notebook: string;
  /** The file name in the notebook's folder. */
  file: string;
  title: string;
  created: number;
  modified: number;
  /** All the words on the page, for searching. */
  text: string;
}

const MEDIA = ".media";

/** A name Windows accepts for a folder: no \ / : * ? " < > |, no dot or space at the end, not a device name. */
export function safeName(name: string): string {
  let clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  clean = clean.replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean)) clean = `${clean} notes`;
  return clean.slice(0, 80) || "Notebook";
}

/** The words of a page, for searching: its title and every bit of text, equations included. */
export function pageText(title: string, items: PageItem[]): string {
  const parts = [title];
  const walk = (node: { text?: string; attrs?: { latex?: string }; content?: unknown[] }) => {
    if (node.text) parts.push(node.text);
    if (node.attrs?.latex) parts.push(node.attrs.latex);
    for (const child of node.content ?? []) walk(child as typeof node);
  };
  for (const item of items) {
    if (item.t === "box" && item.doc && typeof item.doc === "object") walk(item.doc as Parameters<typeof walk>[0]);
    else if ("label" in item && item.label) parts.push(item.label);
  }
  return parts.filter(Boolean).join(" ");
}

/** A file name that sorts by time and can't collide: 20261020-143205-k3x9.json */
export function newPageFile(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}.json`;
}

const listDir = (path: string) => invoke<[string, boolean][]>("list_dir", { path });

export async function listNotebooks(): Promise<string[]> {
  const entries = await listDir("");
  return entries
    .filter(([name, dir]) => dir && !name.startsWith("."))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
}

export async function listPages(notebook: string): Promise<PageInfo[]> {
  const files = (await listDir(notebook)).filter(([name, dir]) => !dir && name.endsWith(".json")).map(([name]) => name);
  const pages = await Promise.all(
    files.map(async (file): Promise<PageInfo | null> => {
      try {
        const page = await readPage(notebook, file);
        return { notebook, file, title: page.title, created: page.created, modified: page.modified, text: pageText(page.title, page.items) };
      } catch (error) {
        console.warn(`Skipping ${notebook}/${file}`, error);
        return null;
      }
    }),
  );
  return pages.filter((p): p is PageInfo => !!p).sort((a, b) => a.created - b.created || a.file.localeCompare(b.file));
}

export async function readPage(notebook: string, file: string): Promise<PageFile> {
  const page = JSON.parse(await invoke<string>("read_text", { path: `${notebook}/${file}` })) as Partial<PageFile>;
  return { title: page.title ?? "", created: page.created ?? 0, modified: page.modified ?? 0, paper: page.paper ?? "plain", items: page.items ?? [] };
}

export function writePage(notebook: string, file: string, page: PageFile): Promise<void> {
  return invoke("write_text", { path: `${notebook}/${file}`, text: JSON.stringify(page) });
}

/** Makes a notebook, with a number added if the name is taken. Returns the name it got. */
export async function createNotebook(name: string, existing: string[]): Promise<string> {
  const base = safeName(name);
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  let unique = base;
  for (let i = 2; taken.has(unique.toLowerCase()); i++) unique = `${base} ${i}`;
  await invoke("make_dir", { path: unique });
  return unique;
}

export async function renameNotebook(from: string, to: string): Promise<string> {
  const name = safeName(to);
  if (name !== from) await invoke("rename_path", { from, to: name });
  return name;
}

export async function createPage(notebook: string, title = ""): Promise<PageInfo> {
  const file = newPageFile();
  const now = Date.now();
  await writePage(notebook, file, { title, created: now, modified: now, paper: "plain", items: [] });
  return { notebook, file, title, created: now, modified: now, text: title };
}

export function movePage(page: PageInfo, notebook: string): Promise<void> {
  return invoke("rename_path", { from: `${page.notebook}/${page.file}`, to: `${notebook}/${page.file}` });
}

/** Moves into the trash folder; returns where it went, so it can be put back. */
export function trash(path: string): Promise<string> {
  return invoke<string>("trash", { path });
}

export function restore(trashed: string, path: string): Promise<void> {
  return invoke("rename_path", { from: trashed, to: path });
}

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg" };

/** Stores a picture with the notes and returns its place, for the image's src. */
export async function savePicture(blob: Blob): Promise<string> {
  const path = `${MEDIA}/${newPageFile().replace(/\.json$/, "")}.${EXTENSIONS[blob.type] ?? "png"}`;
  await invoke("write_bytes", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-path": encodeURIComponent(path) } });
  return path;
}

const pictureUrls = new Map<string, Promise<string>>();

/** An address the page can show a stored picture from. */
export function pictureUrl(src: string): Promise<string> {
  if (!src.startsWith(`${MEDIA}/`)) return Promise.resolve(src);
  let url = pictureUrls.get(src);
  if (!url) {
    const type = Object.entries(EXTENSIONS).find(([, ext]) => src.endsWith(`.${ext}`))?.[0] ?? "image/png";
    url = invoke<ArrayBuffer>("read_bytes", { path: src }).then((bytes) => URL.createObjectURL(new Blob([bytes], { type })));
    pictureUrls.set(src, url);
    url.catch(() => pictureUrls.delete(src));
  }
  return url;
}

export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}
