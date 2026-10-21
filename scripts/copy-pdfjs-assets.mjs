// pdf.js (used to open PDFs) loads character maps, fallback fonts and image
// decoders at runtime, so they are served next to the app, not bundled.
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "pdfjs-dist");
const to = join(root, "public", "pdfjs");

rmSync(to, { recursive: true, force: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) cpSync(join(from, dir), join(to, dir), { recursive: true });
