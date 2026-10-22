// Drives the built app over the DevTools protocol (WebView2 remote debugging)
// and checks what unit tests can't: that notes are written, saved to disk as
// you type, and come back after a restart: text boxes anywhere on the page,
// pictures pasted where clicked, ink and diagrams, zoom, search, deleting
// with undo, and links.
//
//   npm run tauri build -- --no-bundle && npm run smoke
//
// The notes go to a scratch folder (DUCKNOTES_DIR), never to Documents.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = join(root, "src-tauri", "target", "release", "ducknotes.exe");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const work = mkdtempSync(join(tmpdir(), "ducknotes-smoke-"));
const notesDir = join(work, "notes");
const profile = join(work, "profile");

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
}

/** Asks a program's window to close, as clicking its X does. */
const requestClose = (pid) =>
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; [void][U.W]::PostMessage((Get-Process -Id ${pid}).MainWindowHandle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)`,
  ]);

async function session(port, run) {
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      DUCKNOTES_DIR: notesDir,
      DUCKNOTES_TEST_OFFSCREEN: "1",
      DUCKNOTES_MULTI_INSTANCE: "1",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
    } catch {
      // Not listening yet.
    }
  }
  if (!target) {
    child.kill();
    throw new Error("The app did not start, or remote debugging is unavailable");
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  const ipc = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Network.requestWillBeSent" && msg.params.request.url.includes("ipc.localhost")) {
      ipc.push(msg.params.request);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const details = msg.params.exceptionDetails;
      errors.push(details.exception?.description ?? details.text);
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push(msg.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    }
  };
  ws.onclose = () => {
    for (const resolve of pending.values()) resolve({ result: { result: {} } });
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const app = {
    errors,
    ipc,
    child,
    send,
    async evaluate(expression) {
      const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
      return result?.result?.value;
    },
    mouse: (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra }),
    async click(x, y, modifiers = 0) {
      await app.mouse("mouseMoved", x, y, { buttons: 0, modifiers });
      await app.mouse("mousePressed", x, y, { modifiers });
      await app.mouse("mouseReleased", x, y, { modifiers });
    },
    async drag(x1, y1, x2, y2) {
      await app.mouse("mouseMoved", x1, y1, { buttons: 0 });
      await app.mouse("mousePressed", x1, y1);
      for (let i = 1; i <= 8; i++) await app.mouse("mouseMoved", x1 + ((x2 - x1) * i) / 8, y1 + ((y2 - y1) * i) / 8);
      await app.mouse("mouseReleased", x2, y2);
    },
    async key(name, code, modifiers = 0) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code, modifiers });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code, modifiers });
    },
    /** Types one character at a time, as a person does, so typing shortcuts run. */
    async type(text) {
      for (const ch of text) {
        if (ch === "\n") await app.key("Enter", 13);
        else await send("Input.insertText", { text: ch });
      }
    },
    center: (selector, index = 0) =>
      app.evaluate(`(() => {
        const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height];
      })()`),
    async clickOn(selector, index = 0, modifiers = 0) {
      const at = await app.center(selector, index);
      if (!at) throw new Error(`Nothing matches ${selector} [${index}]`);
      await app.click(at[0], at[1], modifiers);
    },
    count: (selector) => app.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
    async waitFor(expression, ms = 8000) {
      for (let t = 0; t < ms; t += 150) {
        if (await app.evaluate(expression)) return true;
        await sleep(150);
      }
      return false;
    },
    /** A scroll-wheel turn; `modifiers`: 1 is Alt, 2 is Ctrl. */
    wheel: (x, y, deltaY, modifiers = 0) => send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers }),
    /** Saves a picture of the window. */
    async shot(file) {
      const { result } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(result.data, "base64"));
    },
    saved: () => app.waitFor(`document.querySelector(".status-text").textContent === "Saved"`),
  };
  await send("Runtime.enable");
  await send("Network.enable");
  try {
    await app.waitFor(`!!document.querySelector(".world")`, 15000);
    await sleep(400);
    await run(app);
  } finally {
    ws.close();
    if (child.exitCode === null) child.kill();
    await sleep(500);
  }
}

const notebookFiles = (name) => (existsSync(join(notesDir, name)) ? readdirSync(join(notesDir, name)).filter((f) => f.endsWith(".json")) : []);
const readNote = (name, file) => JSON.parse(readFileSync(join(notesDir, name, file), "utf8"));
const kinds = (doc) => {
  const found = [];
  const walk = (node) => {
    found.push(node.type);
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return found;
};

let lectureFile = "";
const canvasItems = (app) => app.evaluate(`window.__ducknotes.canvas().toPage().items`);
const pasteImage = (where) => `(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 40; canvas.height = 30;
  const g = canvas.getContext("2d"); g.fillStyle = "#0f766e"; g.fillRect(0, 0, 40, 30);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  const data = new DataTransfer();
  data.items.add(new File([blob], "shot.png", { type: "image/png" }));
  (${where}).dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
})()`;
/** A point on the page, in window coordinates, for page units (x, y). */
/** Window coordinates for page points, scrolling first so they are all in view. */
const spots = (app, ...points) =>
  app.evaluate(`(() => {
    const points = ${JSON.stringify(points)};
    const scroller = document.querySelector(".canvas-scroll");
    const world = document.querySelector(".world");
    const at = () => {
      const r = world.getBoundingClientRect();
      const s = r.width / parseFloat(world.style.width);
      return points.map(([x, y]) => [r.left + x * s, r.top + y * s]);
    };
    const view = scroller.getBoundingClientRect();
    const ys = at().map((p) => p[1]);
    const xs = at().map((p) => p[0]);
    if (Math.min(...ys) < view.top + 10 || Math.max(...ys) > view.bottom - 10) scroller.scrollTop += (Math.min(...ys) + Math.max(...ys)) / 2 - (view.top + view.height / 2);
    if (Math.min(...xs) < view.left + 10 || Math.max(...xs) > view.right - 10) scroller.scrollLeft += (Math.min(...xs) + Math.max(...xs)) / 2 - (view.left + view.width / 2);
    return at().flat();
  })()`);
const spot = (app, x, y) => spots(app, [x, y]);
const dragOn = async (app, x1, y1, x2, y2) => app.drag(...(await spots(app, [x1, y1], [x2, y2])));

// ---- the first start --------------------------------------------------------

await session(9471, async (app) => {
  check("the first start makes a notebook with a page", notebookFiles("My notebook").length === 1, readdirSync(notesDir).join(", "));
  check("and shows it", (await app.evaluate(`document.querySelector(".notebooks .item.selected .item-name")?.textContent`)) === "My notebook");
  lectureFile = notebookFiles("My notebook")[0];

  // A title, then Enter goes to a text box under it.
  await app.clickOn(".page-title");
  await app.type("Lecture 1\n");
  check("Enter in the title starts a text box", (await app.count(".box")) === 1);
  await app.type("# Cells\nThe cell is the unit of life.\n");
  check("# makes a heading", (await app.count(".box h1")) === 1);
  await app.type("[] read chapter 4\nask about mitosis\n\n");
  check("[] makes a checklist that carries on with Enter", (await app.count(".box li.task")) === 2);
  await app.type("Energy: $E=mc^2$ -> light ");
  check("$…$ makes an equation", (await app.count(".box .math math")) === 1);
  check("-> makes an arrow", (await app.evaluate(`document.querySelector(".box .note").textContent.includes("→ light")`)) === true);
  const tick = await app.evaluate(`(() => { const r = document.querySelector(".box li.task").getBoundingClientRect(); return [r.left - 14, r.top + 11]; })()`);
  await app.click(tick[0], tick[1]);
  check("clicking a box ticks it", (await app.count(`.box li.task[data-checked="true"]`)) === 1);

  // Clicking anywhere empty starts writing there.
  const [x1, y1] = await spot(app, 760, 160);
  await app.click(x1, y1);
  check("clicking an empty spot starts a text box there", (await app.count(".box")) === 2);
  await app.type("Organelles");
  const second = (await canvasItems(app)).filter((i) => i.t === "box").find((i) => JSON.stringify(i.doc).includes("Organelles"));
  check("where it was clicked", !!second && Math.abs(second.x - 760) < 2 && Math.abs(second.y - 148) < 2, JSON.stringify(second && [second.x, second.y]));

  // A table in it, from the toolbar's grid.
  await app.type("\n");
  await app.clickOn(`.toolbar .tb[title^="Table"]`);
  await app.clickOn(".grid-cell", 8 + 1);
  check("the toolbar puts in a table", (await app.count(".box table tr")) === 2);
  await app.type("Part");
  await app.key("Tab", 9);
  await app.type("Job");
  await app.key("Tab", 9);
  await app.type("Nucleus");
  check("Tab moves to the next cell", (await app.evaluate(`[...document.querySelectorAll(".box table th, .box table td")].map((c) => c.textContent).join("|")`)) === "Part|Job|Nucleus|");

  // Click a spot, Ctrl+V: the picture lands there.
  const [x2, y2] = await spot(app, 120, 520);
  await app.click(x2, y2);
  await app.evaluate(pasteImage("document.activeElement"));
  check("a picture pasted after clicking a spot lands there", await app.waitFor(`[...document.querySelectorAll(".picture img")].some((img) => img.naturalWidth === 40)`));
  const pics = (await canvasItems(app)).filter((i) => i.t === "picture");
  check("in the place clicked, not in a text box", pics.length === 1 && Math.abs(pics[0].x - 120) < 2 && (await app.count(".box")) === 2, JSON.stringify({ pics, focus: await app.evaluate(`document.activeElement.className`), at: [x2, y2] }));
  // Ctrl+V with nothing picked: it still lands on the page.
  await app.evaluate(`document.activeElement?.blur()`);
  await app.evaluate(pasteImage("document.body"));
  check("a picture pasted with nothing selected lands on the page too", await app.waitFor(`document.querySelectorAll(".picture").length === 2`));
  check("and is stored with the notes", readdirSync(join(notesDir, ".media")).length === 2);

  // Drawing: the pen, then a diagram of two shapes joined by an arrow.
  await app.evaluate(`document.activeElement?.blur()`);
  await app.key("p", 80);
  check("P picks the pen", (await app.evaluate(`window.__ducknotes.pen.tool`)) === "pen");
  const ink = async () => (await canvasItems(app)).filter((i) => !["box", "picture"].includes(i.t));
  await dragOn(app, 400, 520, 520, 600);
  check("the pen draws anywhere on the page", (await ink()).some((i) => i.t === "pen"));
  await app.key("h", 72);
  await dragOn(app, 560, 520, 700, 520);
  check("the highlighter draws in yellow, see-through", (await ink()).some((i) => i.hl && i.c === "#eab308") && (await app.count('.ink path[opacity="0.35"]')) === 1);
  await app.key("z", 90, 2);
  check("Ctrl+Z takes it away again", !(await ink()).some((i) => i.hl));
  await app.key("r", 82);
  await dragOn(app, 400, 700, 540, 770);
  check("a box asks for its words", (await app.count(".ink-input")) === 1);
  await app.type("Nucleus\n");
  await app.key("o", 79);
  await dragOn(app, 700, 700, 840, 780);
  await app.type("DNA\n");
  await app.key("a", 65);
  await dragOn(app, 470, 735, 770, 740);
  let drawn = await ink();
  const arrow = drawn.find((i) => i.t === "arrow");
  const [nucleus, dna] = [drawn.find((i) => i.label === "Nucleus"), drawn.find((i) => i.label === "DNA")];
  check("shapes keep their words", !!nucleus && !!dna, JSON.stringify(drawn));
  check("an arrow drawn between shapes is tied to them", !!arrow && arrow.from === nucleus?.id && arrow.to === dna?.id, JSON.stringify(arrow));
  await app.key("v", 86);
  const lineY = () => app.evaluate(`document.querySelector(".ink line").getAttribute("y1")`);
  const before = await lineY();
  await dragOn(app, 430, 720, 430, 860);
  check("moving a box moves the arrow's end with it", Number(await lineY()) > Number(before) + 50, `${before} → ${await lineY()}`);
  await app.key("z", 90, 2);
  drawn = await ink();
  check("Ctrl+Z undoes the move", Math.abs(drawn.find((i) => i.label === "Nucleus").y - nucleus.y) < 1);
  await app.key("Escape", 27);
  check("Esc goes back to typing", (await app.evaluate(`window.__ducknotes.pen.tool`)) === "type");

  // Zooming with Ctrl+wheel, and writing where clicked while zoomed.
  await app.evaluate(`document.querySelector(".canvas-scroll").scrollTo(0, 0)`);
  const view = await app.evaluate(`(() => { const r = document.querySelector(".canvas-scroll").getBoundingClientRect(); return [r.left + 200, r.top + 200]; })()`);
  for (let i = 0; i < 3; i++) await app.wheel(view[0], view[1], -120, 2);
  check("Ctrl+wheel zooms in", await app.waitFor(`window.__ducknotes.canvas().zoom > 1.3`), String(await app.evaluate(`window.__ducknotes.canvas().zoom`)));
  check("the toolbar shows the zoom", (await app.evaluate(`document.querySelector(".zoom-label").textContent`)) !== "100%");
  const [x3, y3] = await spot(app, 300, 330);
  await app.click(x3, y3);
  const placed = await app.evaluate(`(() => { const r = document.querySelector(".box:focus-within").getBoundingClientRect(); return [r.left, r.top]; })()`);
  check("a box made while zoomed appears where clicked", Math.abs(placed[0] - x3) < 6, `${placed} vs ${[x3, y3]}`);
  await app.type("zoomed");
  await app.clickOn(".zoom-label");
  check("clicking the zoom goes back to 100%", (await app.evaluate(`window.__ducknotes.canvas().zoom`)) === 1);

  // Alt+wheel makes selected text bigger.
  await app.evaluate(`(() => { window.__ducknotes.view().focus(); document.execCommand("selectAll"); })()`);
  const at = await app.center(".box:focus-within");
  await app.wheel(at[0], at[1], -100, 1);
  await app.wheel(at[0], at[1], -100, 1);
  check("Alt+wheel makes the text bigger", (await app.evaluate(`[...document.querySelectorAll(".box:focus-within span")].some((s) => s.style.fontSize === "18px")`)) === true);

  // Lined paper.
  await app.evaluate(`(() => { const s = document.querySelector('.toolbar select[aria-label="Paper"]'); s.value = "lines"; s.dispatchEvent(new Event("change")); })()`);
  check("the paper can be lined", (await app.evaluate(`document.querySelector(".world").dataset.paper`)) === "lines");

  // A link: typed, then Ctrl+click.
  await app.clickOn(".box .note h1");
  await app.key("End", 35, 2);
  await app.type("\nSee https://duck.no/biology ");
  check("a typed address becomes a link", (await app.count(`.box a[href="https://duck.no/biology"]`)) === 1);
  await app.clickOn(".box a", 0, 2);
  await app.waitFor("false", 400);
  const opened = app.ipc.filter((r) => r.method === "POST" && r.url.endsWith("/open_url")).map((r) => JSON.parse(r.postData).url);
  check("Ctrl+click opens the link", opened[0] === "https://duck.no/biology", JSON.stringify(opened));

  // It's all on disk.
  check("the page saves by itself", await app.saved());
  const note = readNote("My notebook", lectureFile);
  const types = note.items.map((i) => i.t);
  check("the file has the title and paper", note.title === "Lecture 1" && note.paper === "lines", `${note.title} ${note.paper}`);
  for (const t of ["box", "picture", "pen", "rect", "ellipse", "arrow"]) check(`the file has a ${t}`, types.includes(t), types.join(","));
  const boxKinds = kinds({ content: note.items.filter((i) => i.t === "box").map((i) => i.doc) });
  for (const kind of ["heading", "bullet_list", "table", "math"]) check(`a text box has the ${kind}`, boxKinds.includes(kind));

  // A second notebook, made from the + button.
  await app.clickOn(`.notebooks .tb[aria-label="New notebook"]`);
  await app.type("Physics\n");
  check("a new notebook gets its first page", await app.waitFor(`document.querySelector(".notebooks .item.selected .item-name")?.textContent === "Physics"`));
  await app.type("Forces\n");
  await app.type("F = ma, as Newton said.");
  check("which saves into its own folder", (await app.saved()) && notebookFiles("Physics").length === 1);

  // Searching all notes.
  await app.key("e", 69, 2);
  await app.type("mitosis");
  check("search finds the page in the other notebook", await app.waitFor(`document.querySelectorAll(".pages-list .page-item").length === 1`));
  await app.clickOn(".pages-list .page-item");
  check("and opens it with the words marked", await app.waitFor(`document.querySelector(".page-title")?.value === "Lecture 1" && !!document.querySelector(".box .search-hit")`));

  // Deleting a page, and undoing it.
  await app.clickOn(`.notebooks .item[data-notebook="Physics"] .item-name`);
  await app.waitFor(`document.querySelector(".page-title")?.value === "Forces"`);
  const physics = notebookFiles("Physics")[0];
  const page = await app.center(".pages-list .page-item");
  await app.mouse("mousePressed", page[0], page[1], { button: "right", buttons: 2 });
  await app.mouse("mouseReleased", page[0], page[1], { button: "right", buttons: 0 });
  await app.waitFor(`!!document.querySelector(".menu")`);
  await app.clickOn(".menu-item.danger");
  check("deleting moves the page to the trash", (await app.waitFor(`document.querySelector(".pages-list .list-empty") !== null`)) && notebookFiles("Physics").length === 0 && readdirSync(join(notesDir, ".trash")).length === 1);
  await app.clickOn(".toast .btn");
  check("Undo brings it back", (await app.waitFor(`document.querySelector(".page-title")?.value === "Forces"`)) && notebookFiles("Physics")[0] === physics);

  // Closing the window right after typing loses nothing.
  await app.clickOn(".box .note p");
  await app.key("End", 35, 2);
  await app.type(" Written just before closing.");
  check("no errors in the app", app.errors.length === 0, app.errors.join("; "));
  requestClose(app.child.pid);
  for (let i = 0; i < 40 && app.child.exitCode === null; i++) await sleep(250);
  check("the window closes", app.child.exitCode !== null);
  check("closing saves what was just typed", JSON.stringify(readNote("Physics", physics).items).includes("Written just before closing."));
});

// ---- the next start ---------------------------------------------------------

await session(9472, async (app) => {
  check("it opens where you left off", await app.waitFor(`document.querySelector(".page-title")?.value === "Forces"`));
  await app.clickOn(`.notebooks .item[data-notebook="My notebook"] .item-name`);
  check("the lecture comes back", await app.waitFor(`document.querySelector(".page-title")?.value === "Lecture 1"`));
  check("with its text boxes", (await app.count(".box")) === 3, String(await app.count(".box")));
  check("its checklist", (await app.count(`.box li.task[data-checked="true"]`)) === 1);
  check("its table", (await app.count(".box table tr")) === 2);
  check("its drawing", (await app.count(".ink g[data-id]")) === 4, String(await app.count(".ink g[data-id]")));
  check("its pictures", await app.waitFor(`[...document.querySelectorAll(".picture img")].filter((img) => img.naturalWidth === 40).length === 2`));
  check("and its lined paper", (await app.evaluate(`document.querySelector(".world").dataset.paper`)) === "lines");
  // Right-click → Section → New section… files the page under a heading in the list.
  const pick = (label) => app.evaluate(`[...document.querySelectorAll(".menu .menu-item")].find((b) => b.textContent.startsWith(${JSON.stringify(label)}))?.click() ?? "none"`);
  await app.evaluate(`document.querySelector(".pages-list .page-item.selected").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 200 }))`);
  await pick("Section");
  await pick("New section");
  await app.evaluate(`(() => { const input = document.querySelector(".dialog input"); input.value = "Week 1"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  check("a page can be filed under a section", await app.waitFor(`document.querySelector(".pages-list .section-heading")?.textContent === "Week 1"`));
  check("which is saved with the page", await app.waitFor(`true`) && notebookFiles("My notebook").some((file) => readNote("My notebook", file).section === "Week 1"));
  check("no errors after starting again", app.errors.length === 0, app.errors.join("; "));
});

// ---- lecture slides, and picking several things -----------------------------

/** A small PDF with `count` pages of 400 × 300 points, each with a filled box. */
function makePdf(count) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids = [];
  for (let i = 0; i < count; i++) {
    const content = `0.2 0.4 0.8 rg 40 40 ${120 + i * 100} 200 re f`;
    kids.push(`${objects.length + 1} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents ${objects.length + 2} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${count} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

await session(9473, async (app) => {
  await app.key("n", 78, 2);
  await app.waitFor(`document.querySelector(".page-title")?.value === ""`);
  await app.type("Lecture 2");
  // The Slides button's file picker, given a PDF as if chosen.
  check("the toolbar has a button for slides", (await app.count(`.toolbar .tb[title^="Slides from a PDF"]`)) === 1);
  await app.evaluate(`(() => {
    const input = document.querySelector(".slides-input");
    const data = new DataTransfer();
    data.items.add(new File([${JSON.stringify(makePdf(2))}], "Lecture 2.pdf", { type: "application/pdf" }));
    input.files = data.files;
    input.dispatchEvent(new Event("change"));
  })()`);
  check("each page of the PDF becomes a slide", await app.waitFor(`[...document.querySelectorAll(".picture.slide img")].filter((img) => img.naturalWidth === 1600).length === 2`, 20000), String(await app.count(".picture.slide")));
  const slides = (await canvasItems(app)).filter((i) => i.t === "picture");
  check("one under the other, marked as slides", slides.length === 2 && slides.every((s) => s.slide && s.w === 720 && s.x === 48) && slides[1].y > slides[0].y + 540, JSON.stringify(slides));

  // Clicking a slide writes on it rather than moving it.
  const [sx, sy] = await spot(app, 300, 300);
  await app.click(sx, sy);
  await app.type("Remember this");
  let items = await canvasItems(app);
  const note = items.find((i) => i.t === "box");
  check("clicking a slide starts a text box on it", !!note && Math.abs(note.x - 300) < 2 && JSON.stringify(note.doc).includes("Remember this"), JSON.stringify(note));
  check("and the slide stays put", items.find((i) => i.id === slides[0].id)?.x === 48);
  check("text written on a slide shows over it", await app.evaluate(`document.querySelector(".picture.slide").compareDocumentPosition(document.querySelector(".box")) === Node.DOCUMENT_POSITION_FOLLOWING`));

  // Dragging a rectangle round the first slide and the note picks both.
  await app.evaluate(`document.activeElement?.blur()`);
  await app.key("v", 86);
  await dragOn(app, 20, 90, 840, 670);
  check("dragging round things with the select tool picks them", (await app.count(".chosen")) === 2 && (await app.count(".ink-selection.group")) === 1, String(await app.count(".chosen")));
  await dragOn(app, 400, 400, 500, 450);
  items = await canvasItems(app);
  const moved = (id) => items.find((i) => i.id === id);
  check("dragging them moves them together", moved(slides[0].id).x === 148 && moved(note.id).x === note.x + 100 && moved(note.id).y === note.y + 50, JSON.stringify([moved(slides[0].id), moved(note.id)].map((i) => [i.x, i.y])));
  check("and leaves the rest", moved(slides[1].id).x === 48);
  await app.key("z", 90, 2);
  items = await canvasItems(app);
  check("Ctrl+Z puts them back in one step", moved(slides[0].id).x === 48 && moved(note.id).x === note.x);

  // A rectangle dragged round a pen stroke on a slide picks just the stroke; Delete removes, Ctrl+Z restores.
  await app.key("p", 80);
  await dragOn(app, 100, 800, 200, 820);
  await app.key("v", 86);
  await dragOn(app, 80, 760, 240, 860);
  check("a rectangle dragged round a drawing on a slide picks it", (await app.count(".ink-selection.group")) === 1 && (await app.count(".chosen")) === 0);
  await app.key("Delete", 46);
  check("Delete removes what's picked", !(await canvasItems(app)).some((i) => i.t === "pen"));
  await app.key("z", 90, 2);
  check("and Ctrl+Z brings it back", (await canvasItems(app)).some((i) => i.t === "pen"));
  await app.key("a", 65, 2);
  check("Ctrl+A with the select tool picks everything", (await app.count(".chosen")) === 3);
  await app.key("Escape", 27);
  check("Esc lets go", (await app.count(".chosen")) === 0 && (await app.count(".ink-selection.group")) === 0);
  check("the slides are saved with the page", (await app.saved()) && readdirSync(join(notesDir, ".media")).filter((f) => f.endsWith(".jpg")).length === 2);
  // Ctrl+drag moves the view, with any tool.
  await app.evaluate(`document.querySelector(".canvas-scroll").scrollTo(0, 300)`);
  const [px, py] = await app.evaluate(`(() => { const r = document.querySelector(".canvas-scroll").getBoundingClientRect(); return [r.left + 300, r.top + 300]; })()`);
  const groupsBefore = await app.count(".ink-selection.group");
  await app.mouse("mouseMoved", px, py, { buttons: 0, modifiers: 2 });
  await app.mouse("mousePressed", px, py, { modifiers: 2 });
  for (let i = 1; i <= 8; i++) await app.mouse("mouseMoved", px, py - i * 20, { modifiers: 2 });
  await app.mouse("mouseReleased", px, py - 160, { modifiers: 2 });
  const top = await app.evaluate(`document.querySelector(".canvas-scroll").scrollTop`);
  check("Ctrl+drag moves the view instead of picking", top > 400 && (await app.count(".ink-selection.group")) === groupsBefore, `scrollTop ${top}`);
  // Tags: Ctrl+2 marks the line important; the Important button under search finds the page.
  await app.evaluate(`(() => { const v = window.__ducknotes.canvas().focusText(); })()`);
  await app.key("2", 50, 2);
  check("Ctrl+2 tags the line as important", await app.waitFor(`!!document.querySelector('.box p[data-tag="important"]')`, 3000));
  await app.saved();
  await app.clickOn(".tag-chip");
  check("and the Important button finds the page", await app.waitFor(`document.querySelector(".search").value === "#important" && [...document.querySelectorAll(".pages-list .page-item")].some((li) => li.textContent.includes("Lecture 2"))`, 5000));
  await app.evaluate(`(() => { const s = document.querySelector(".search"); s.value = ""; s.dispatchEvent(new Event("input")); })()`);

  // Printing shows only the page: no lists, no toolbar; the PDF keeps the slides and the text.
  await app.send("Emulation.setEmulatedMedia", { media: "print" });
  const printed = await app.evaluate(`["notebooks", "pages", "toolbar"].map((c) => getComputedStyle(document.querySelector("." + c)).display).join() + "|" + getComputedStyle(document.querySelector(".world")).display`);
  check("printing leaves out everything but the page", printed === "none,none,none|block", printed);
  const pdf = await app.send("Page.printToPDF", { printBackground: true });
  check("and makes a PDF of it", (pdf.result?.data?.length ?? 0) > 5000, String(pdf.result?.data?.length));
  await app.send("Emulation.setEmulatedMedia", { media: "" });
  check("no errors with slides and picking", app.errors.length === 0, app.errors.join("; "));
});

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
