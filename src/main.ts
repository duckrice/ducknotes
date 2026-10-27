// DuckNotes: notebooks on the left, their pages next to them, and the page
// being written on the right. Everything saves by itself as you type.

import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setSpellChecker } from "./spelling";
import { showSpellMenu } from "./spellmenu";
import { windowsSpelling } from "./store";
import { Canvas } from "./canvas";
import { h, isTyping } from "./dom";
import { icon } from "./icons";
import { pen } from "./ink";
import {
  bySection,
  createNotebook,
  createPage,
  listNotebooks,
  listPages,
  movePage,
  readPage,
  renameNotebook,
  restore,
  trash,
  writePage,
  pageText,
  type PageFile,
  type PageInfo,
} from "./store";
import { TOOL_KEYS, createToolbar } from "./toolbar";
import { ask, askName, menu, toast, type MenuItem } from "./ui";
import { offerUpdate } from "./updates";

const LAST_PAGE = "ducknotes.lastPage";

let notebooks: string[] = [];
let pages: PageInfo[] = [];
let notebook = "";
let query = "";
let current: { info: PageInfo; canvas: Canvas } | null = null;
let zoom = 1;

// ---- the window -------------------------------------------------------------

const notebookList = h("ul", { class: "list", role: "listbox", "aria-label": "Notebooks" });
const pageList = h("ul", { class: "list pages-list", role: "listbox", "aria-label": "Pages" });
const search = h("input", { type: "search", class: "search", placeholder: "Search all notes (Ctrl+E)", "aria-label": "Search all notes" }) as HTMLInputElement;
const pagesHeading = h("h2", { class: "column-title" });
/** Every tagged line in all notebooks, found by searching for its tag. */
const tagChips = h(
  "div",
  { class: "tag-chips" },
  ...([
    ["★ Important", "#important"],
    ["? Questions", "#question"],
    ["E Exam", "#exam"],
  ] as const).map(([label, word]) =>
    h("button", {
      type: "button",
      class: "tag-chip",
      title: `Pages with lines tagged ${word.slice(1)}`,
      onclick: () => {
        search.value = word;
        search.dispatchEvent(new Event("input"));
      },
    }, label),
  ),
);
const newPageButton = h("button", { type: "button", class: "btn primary small new-page", title: "New page (Ctrl+N)", html: `${icon("plus", 16)}<span>Page</span>` });
const status = h("span", { class: "status-text", role: "status" });
const emptyState = h("div", { class: "empty-state" });
const canvasHost = h("div", { class: "canvas-host" }, emptyState);
const pictureInput = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true }) as HTMLInputElement;
const slidesInput = h("input", { type: "file", accept: ".pdf,application/pdf", hidden: true, class: "slides-input" }) as HTMLInputElement;

/** The text box a picture from the Picture button goes into, if one had the cursor. */
let pictureTarget: Canvas["active"] = null;
const toolbar = createToolbar({
  view: () => current?.canvas.active?.view ?? null,
  canvas: () => current?.canvas ?? null,
  insertPicture: () => {
    const active = current?.canvas.active;
    pictureTarget = active?.view.hasFocus() ? active : null;
    pictureInput.click();
  },
  insertSlides: () => slidesInput.click(),
});

const app = document.getElementById("app")!;
app.append(
  h(
    "aside",
    { class: "column notebooks" },
    h("div", { class: "brand" }, h("span", { class: "brand-mark", html: icon("notebook", 18) }), "DuckNotes"),
    h(
      "div",
      { class: "column-head" },
      h("h2", { class: "column-title" }, "Notebooks"),
      h("button", { type: "button", class: "tb", title: "New notebook", "aria-label": "New notebook", html: icon("plus"), onclick: () => void newNotebook() }),
    ),
    notebookList,
  ),
  h("aside", { class: "column pages" }, search, tagChips, h("div", { class: "column-head" }, pagesHeading, newPageButton), pageList),
  h("main", { class: "page-area" }, toolbar.el, canvasHost, h("div", { class: "status" }, status, toolbar.zoomBar)),
  pictureInput,
  slidesInput,
);

// ---- dates ------------------------------------------------------------------

const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

// ---- the lists --------------------------------------------------------------

function showNotebooks() {
  notebookList.replaceChildren(
    ...notebooks.map((name) => {
      const count = pages.filter((p) => p.notebook === name).length;
      const more = h("button", { type: "button", class: "tb more", title: "More", "aria-label": `More for ${name}`, html: icon("more", 16) });
      const item = h(
        "li",
        { class: `item${name === notebook && !query ? " selected" : ""}`, role: "option", "aria-selected": String(name === notebook), tabindex: "0", "data-notebook": name },
        h("span", { class: "item-icon", html: icon("notebook", 16) }),
        h("span", { class: "item-name" }, name),
        h("span", { class: "item-count" }, String(count)),
        more,
      );
      const open = () => void selectNotebook(name);
      item.addEventListener("click", (event) => {
        if (!more.contains(event.target as Node)) open();
      });
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter") open();
      });
      const options = (anchor: HTMLElement) => menu(anchor, notebookMenu(name));
      more.addEventListener("click", () => options(more));
      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        options(item);
      });
      return item;
    }),
  );
}

function showPages() {
  const found = query ? searchResults() : pages.filter((p) => p.notebook === notebook);
  pagesHeading.textContent = query ? `${found.length} found` : notebook || "Pages";
  newPageButton.hidden = !!query || !notebook;
  if (!found.length) {
    pageList.replaceChildren(h("li", { class: "list-empty" }, query ? "Nothing found." : "No pages yet."));
    return;
  }
  let section: string | undefined;
  pageList.replaceChildren(
    ...(query ? found : bySection(found)).flatMap((info) => {
      const active = current?.info === info;
      const item = h(
        "li",
        { class: `item page-item${active ? " selected" : ""}`, role: "option", "aria-selected": String(active), tabindex: "0", "data-file": info.file },
        h("span", { class: "item-name" }, info.title || "Untitled page"),
        h("span", { class: "item-sub" }, query ? `${info.notebook} · ${snippet(info)}` : shortDate(info.created)),
      );
      item.addEventListener("click", () => void openPage(info));
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void openPage(info);
      });
      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        menu(item, pageMenu(info));
      });
      if (query || info.section === section) return [item];
      section = info.section;
      return [h("li", { class: "section-heading", role: "presentation" }, section ?? ""), item];
    }),
  );
}

function searchResults(): PageInfo[] {
  const words = query.toLowerCase();
  return pages.filter((p) => p.text.toLowerCase().includes(words)).sort((a, b) => b.modified - a.modified);
}

/** The words around the first match. */
function snippet(info: PageInfo): string {
  const at = info.text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return "";
  const start = Math.max(0, at - 30);
  return `${start ? "…" : ""}${info.text.slice(start, at + query.length + 50).trim()}…`;
}

function showEmpty() {
  const nothing = !current;
  toolbar.el.classList.toggle("disabled", nothing);
  emptyState.hidden = !nothing;
  if (nothing)
    emptyState.replaceChildren(
      h("p", {}, notebook ? `${notebook} has no pages yet.` : "Make a notebook to start."),
      notebook
        ? h("button", { type: "button", class: "btn primary", onclick: () => void newPage() }, "New page")
        : h("button", { type: "button", class: "btn primary", onclick: () => void newNotebook() }, "New notebook"),
    );
}

// ---- notebooks --------------------------------------------------------------

async function selectNotebook(name: string) {
  clearSearch();
  notebook = name;
  showNotebooks();
  showPages();
  const first = pages.find((p) => p.notebook === name);
  if (current?.info.notebook !== name) {
    if (first) await openPage(first);
    else await closePage();
  }
}

async function newNotebook() {
  const name = await askName("New notebook", "", "Make notebook");
  if (!name) return;
  try {
    const made = await createNotebook(name, notebooks);
    notebooks = await listNotebooks();
    notebook = made;
    await newPage();
  } catch (error) {
    failed("The notebook could not be made", error);
  }
}

function notebookMenu(name: string): MenuItem[] {
  return [
    { label: "New page", action: () => void selectNotebook(name).then(newPage) },
    { label: "Rename…", action: () => void renameNotebookNamed(name) },
    { label: "Delete…", danger: true, action: () => void deleteNotebook(name) },
  ];
}

async function renameNotebookNamed(name: string) {
  const to = await askName("Rename notebook", name, "Rename");
  if (!to || to === name) return;
  await flush();
  try {
    const renamed = await renameNotebook(name, to);
    for (const p of pages) if (p.notebook === name) p.notebook = renamed;
    if (notebook === name) notebook = renamed;
    notebooks = await listNotebooks();
    refresh();
  } catch (error) {
    failed("The notebook could not be renamed", error);
  }
}

async function deleteNotebook(name: string) {
  const count = pages.filter((p) => p.notebook === name).length;
  const sure = await ask(`Delete ${name}?`, `The notebook and its ${count} page${count === 1 ? "" : "s"} go to the trash folder in Documents\\DuckNotes, so they can be got back.`, "Delete notebook");
  if (!sure) return;
  await flush();
  try {
    const trashed = await trash(name);
    if (current?.info.notebook === name) await closePage(false);
    const gone = pages.filter((p) => p.notebook === name);
    pages = pages.filter((p) => p.notebook !== name);
    notebooks = notebooks.filter((n) => n !== name);
    if (notebook === name) notebook = notebooks[0] ?? "";
    refresh();
    if (!current && notebook) await selectNotebook(notebook);
    toast(`Deleted ${name}.`, async () => {
      await restore(trashed, name);
      notebooks = await listNotebooks();
      pages.push(...gone);
      await selectNotebook(name);
    });
  } catch (error) {
    failed("The notebook could not be deleted", error);
  }
}

// ---- pages ------------------------------------------------------------------

async function newPage() {
  if (!notebook) return;
  clearSearch();
  try {
    const info = await createPage(notebook);
    pages.push(info);
    await openPage(info);
    current?.canvas.title.focus();
  } catch (error) {
    failed("The page could not be made", error);
  }
}

/**
 * Prints the open page, or saves it as a PDF (choose "Microsoft Print to PDF"): only the page,
 * at its own size, made smaller if it's wider than the paper.
 */
async function printPage() {
  if (!current) return;
  await flush();
  // No text cursor on the paper.
  (document.activeElement as HTMLElement | null)?.blur?.();
  const world = current.canvas.world;
  // About the width of A4 between its margins, in CSS pixels.
  const paper = 700;
  const wide = Math.max(...[...world.querySelectorAll<HTMLElement>(".box, .picture")].map((el) => el.offsetLeft + el.offsetWidth), 640);
  document.documentElement.style.setProperty("--print-zoom", String(Math.min(1, paper / wide)));
  window.print();
}

function pageMenu(info: PageInfo): MenuItem[] {
  const others = notebooks.filter((name) => name !== info.notebook);
  return [
    { label: "Print or save as PDF… (Ctrl+P)", action: () => void openPage(info).then(printPage) },
    { label: "Move to", items: others.map((name) => ({ label: name, action: () => void movePageTo(info, name) })) },
    {
      label: "Section",
      items: [
        ...[...new Set(pages.filter((p) => p.notebook === info.notebook && p.section).map((p) => p.section!))].sort().map((name) => ({ label: name, action: () => void setSection(info, name) })),
        { label: "New section…", action: () => void askName("New section", "", "Make section").then((name) => (name?.trim() ? setSection(info, name.trim()) : undefined)) },
        ...(info.section ? [{ label: "No section", action: () => void setSection(info, undefined) }] : []),
      ],
    },
    { label: "Delete", danger: true, action: () => void deletePage(info) },
  ];
}

/** Files a page under a section of its notebook, or under none. */
async function setSection(info: PageInfo, section: string | undefined) {
  info.section = section;
  try {
    if (current?.info === info) await save();
    else await writePage(info.notebook, info.file, { ...(await readPage(info.notebook, info.file)), section });
    refresh();
  } catch (error) {
    failed("The page could not be moved to the section", error);
  }
}

async function movePageTo(info: PageInfo, to: string) {
  if (current?.info === info) await flush();
  try {
    await movePage(info, to);
    info.notebook = to;
    refresh();
    toast(`Moved to ${to}.`);
  } catch (error) {
    failed("The page could not be moved", error);
  }
}

async function deletePage(info: PageInfo) {
  const path = `${info.notebook}/${info.file}`;
  if (current?.info === info) await flush();
  try {
    const trashed = await trash(path);
    const index = pages.indexOf(info);
    pages.splice(index, 1);
    if (current?.info === info) {
      const same = pages.filter((p) => p.notebook === info.notebook);
      const next = same.find((p) => p.created >= info.created) ?? same[same.length - 1];
      if (next) await openPage(next, false);
      else await closePage(false);
    }
    refresh();
    toast(`Deleted ${info.title || "Untitled page"}.`, async () => {
      await restore(trashed, path);
      pages.splice(index, 0, info);
      await openPage(info);
    });
  } catch (error) {
    failed("The page could not be deleted", error);
  }
}

async function openPage(info: PageInfo, save = true) {
  if (current?.info === info) return;
  if (save) await flush();
  let page: PageFile;
  try {
    page = await readPage(info.notebook, info.file);
  } catch (error) {
    failed("The page could not be opened", error);
    return;
  }
  current?.canvas.destroy();
  const canvas = new Canvas(
    canvasHost,
    page,
    {
      onChange: scheduleSave,
      onActive: (view) => toolbar.update(view?.state ?? null),
      onTitle: (text) => {
        if (!current) return;
        current.info.title = text;
        setWindowTitle();
        const item = pageList.querySelector(".page-item.selected .item-name");
        if (item) item.textContent = text || "Untitled page";
        scheduleSave();
      },
      onZoom: (value) => {
        zoom = value;
        toolbar.showZoom(value);
      },
      onTool: () => toolbar.showPen(),
      onError: failed,
    },
    zoom,
  );
  current = { info, canvas };
  notebook = info.notebook;
  toolbar.update(null);
  toolbar.showPaper(page.paper);
  setWindowTitle();
  try {
    localStorage.setItem(LAST_PAGE, `${info.notebook}/${info.file}`);
  } catch {
    // Remembering the page is a convenience only.
  }
  if (query) canvas.search(query);
  status.textContent = "";
  showEmpty();
  showNotebooks();
  showPages();
}

async function closePage(save = true) {
  if (save) await flush();
  current?.canvas.destroy();
  current = null;
  setWindowTitle();
  showEmpty();
  showPages();
}

function setWindowTitle() {
  const name = current ? current.canvas.title.value.trim() || "Untitled page" : "";
  const text = name ? `${name} – DuckNotes` : "DuckNotes";
  document.title = text;
  void getCurrentWindow().setTitle(text).catch(() => {});
}

// ---- saving -----------------------------------------------------------------

let saveTimer = 0;
let saving: Promise<void> = Promise.resolve();

function scheduleSave() {
  clearTimeout(saveTimer);
  status.textContent = "Saving…";
  status.classList.remove("error");
  saveTimer = window.setTimeout(() => void save(), 600);
}

/** Saves the open page now (writes one at a time, in order). */
function save(): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = 0;
  const open = current;
  if (!open) return saving;
  const page = { ...open.canvas.toPage(), modified: Date.now(), section: open.info.section };
  open.info.title = page.title;
  open.info.modified = page.modified;
  open.info.text = pageText(page.title, page.items);
  saving = saving.then(async () => {
    try {
      await writePage(open.info.notebook, open.info.file, page);
      if (current === open && !saveTimer) status.textContent = "Saved";
    } catch (error) {
      status.textContent = "Not saved. Your notes are still here; DuckNotes will try again when you type.";
      status.classList.add("error");
      console.error("Saving failed", error);
    }
  });
  return saving;
}

/** Saves now if anything is waiting to be saved. */
function flush(): Promise<void> {
  return saveTimer ? save() : saving;
}

// ---- pictures ----------------------------------------------------------------

pictureInput.addEventListener("change", () => {
  const files = [...(pictureInput.files ?? [])];
  pictureInput.value = "";
  const canvas = current?.canvas;
  if (!files.length || !canvas) return;
  const into = pictureTarget;
  pictureTarget = null;
  void (into ? canvas.picturesInBox(into, files, null) : canvas.placePictures(files)).catch((error) => failed("The picture could not be added", error));
});

slidesInput.addEventListener("change", () => {
  const file = slidesInput.files?.[0];
  slidesInput.value = "";
  const canvas = current?.canvas;
  if (!file || !canvas) return;
  toast("Adding the slides…");
  void canvas.placeSlides(file).then(
    () => document.querySelector(".toast")?.remove(),
    (error) => failed("The slides could not be added", error),
  );
});

// Ctrl+V with no text box or field to take it: onto the page.
document.addEventListener("paste", (event) => {
  const target = event.target as Element;
  if (!current || target.closest?.(".ProseMirror") || isTyping(target)) return;
  void current.canvas.paste(event).catch((error) => failed("That could not be pasted", error));
});

// ---- search -----------------------------------------------------------------

function clearSearch() {
  if (!query && !search.value) return;
  search.value = "";
  query = "";
  current?.canvas.search("");
  showNotebooks();
}

search.addEventListener("input", () => {
  query = search.value.trim();
  current?.canvas.search(query);
  showNotebooks();
  showPages();
});
search.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    clearSearch();
    showPages();
  } else if (event.key === "Enter") pageList.querySelector<HTMLElement>(".page-item")?.click();
});

// ---- keys -------------------------------------------------------------------

window.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const canvas = current?.canvas;
  if (mod && !event.altKey) {
    if (key === "n" && !event.shiftKey) void newPage();
    else if (key === "e" || key === "f") {
      search.focus();
      search.select();
    } else if (key === "k" && !event.shiftKey && canvas?.active?.view.hasFocus()) toolbar.editLink();
    else if (key === "s") void flush();
    else if (key === "p" && current) void printPage();
    else if (key === "a" && canvas && pen.tool === "select" && !isTyping(event.target)) canvas.selectAll();
    else if (canvas && !isTyping(event.target) && (key === "z" || key === "y")) {
      if (key === "y" || event.shiftKey) canvas.redo();
      else canvas.undo();
    } else return;
    event.preventDefault();
    return;
  }
  // Outside the text: keys for the page itself.
  if (!canvas || isTyping(event.target) || event.altKey) return;
  if (event.key === "Delete" || event.key === "Backspace") {
    if (!canvas.removeChosen()) return;
  } else if (event.key === "Escape") canvas.setTool("type");
  else if (!mod && TOOL_KEYS[key]) canvas.setTool(TOOL_KEYS[key]);
  else return;
  event.preventDefault();
});

newPageButton.addEventListener("click", () => void newPage());

// ---- start ------------------------------------------------------------------

function refresh() {
  showNotebooks();
  showPages();
  showEmpty();
}

function failed(what: string, error: unknown) {
  console.error(what, error);
  toast(`${what}: ${error instanceof Error ? error.message : String(error)}`);
}

async function start() {
  notebooks = await listNotebooks();
  if (!notebooks.length) {
    // The first time: a notebook to write in.
    notebooks = [await createNotebook("My notebook", [])];
    await createPage(notebooks[0]);
  }
  pages = (await Promise.all(notebooks.map((name) => listPages(name)))).flat();
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_PAGE);
  } catch {
    last = null;
  }
  const open = pages.find((p) => `${p.notebook}/${p.file}` === last) ?? pages.find((p) => p.notebook === notebooks[0]);
  notebook = open?.notebook ?? notebooks[0];
  refresh();
  if (open) await openPage(open);
  if (current && !current.canvas.toPage().items.length) current.canvas.title.focus();

  // Nothing typed is lost when the window is closed.
  void getCurrentWindow().onCloseRequested(() => flush());
  void offerUpdate(app, { beforeInstall: () => flush().then(() => true) });
}

// For the tests, which drive the app from outside.
Object.assign(window, { __ducknotes: { canvas: () => current?.canvas, view: () => current?.canvas.active?.view, flush, info: () => current?.info, pen } });

setSpellChecker(windowsSpelling, showSpellMenu);
start().catch((error) => failed("DuckNotes could not start", error));
