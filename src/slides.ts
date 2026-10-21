// Lecture slides from a PDF: each page becomes a picture on the canvas, to
// write and draw on. Loaded only when a PDF is added, so pdf.js doesn't slow
// down starting DuckNotes.

import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

const asset = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

/** Each page of a PDF as a picture `width` pixels wide: sharp at twice the size it is placed at. */
export async function pdfPages(file: File, width = 1600): Promise<File[]> {
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: asset("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: asset("standard_fonts"),
    wasmUrl: asset("wasm"),
    iccUrl: asset("iccs"),
  });
  task.onPassword = () => void task.destroy();
  let pdf;
  try {
    pdf = await task.promise;
  } catch (error) {
    if (task.destroyed) throw new Error("the PDF is protected with a password. Open it in Duckument, save a copy without the password, and add that");
    throw error;
  }
  try {
    const name = file.name.replace(/\.pdf$/i, "");
    const pages: File[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport }).promise;
      page.cleanup();
      // JPEG: a fraction of the size of PNG for slides with photos, and still crisp for text.
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
      if (!blob) throw new Error(`page ${n} could not be made into a picture`);
      pages.push(new File([blob], `${name} ${n}.jpg`, { type: "image/jpeg" }));
    }
    return pages;
  } finally {
    void task.destroy();
  }
}
