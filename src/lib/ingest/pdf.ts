import type { IngestResult } from "./index";
import type { PDFPageProxy } from "pdfjs-dist";

function fileName(file: File | Blob): string | undefined {
  return typeof File !== "undefined" && file instanceof File ? file.name : undefined;
}

function titleFromFilename(name: string): string {
  return name
    .replace(/\.[^./\\]+$/, "")
    .trim()
    .slice(0, 80);
}

/* A page is "image-only" if its operator list paints at least one image
   object (JPEG, inline image, or image mask). `ops` is pdfjs's OPS enum,
   obtained lazily from the module namespace (it's a runtime value, so it
   must not be imported at module top level). */
function hasImageOperator(
  page: PDFPageProxy,
  ops: Record<string, number>,
): Promise<boolean> {
  return page
    .getOperatorList()
    .then((opList) => {
      const paint = new Set([
        ops.paintImageXObject,
        ops.paintJpegXObject,
        ops.paintImageMaskXObject,
        ops.paintInlineImageXObject,
      ]);
      return opList.fnArray.some((fn) => paint.has(fn));
    })
    .catch(() => false);
}

/* Encode an ArrayBuffer as a base64 data URL without a FileReader. */
function bytesToDataUrl(data: ArrayBuffer, mime: string): string {
  const bytes = new Uint8Array(data);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

/* Extract text from every page of a PDF via pdfjs-dist. Browser-only — the
   library relies on DOM globals (DOMMatrix, etc.) that don't exist under
   Node, so both the guard and the import itself are lazy: nothing here runs
   (or is even loaded) unless this function is actually called. */
export async function ingestPdf(file: File | Blob): Promise<IngestResult> {
  if (typeof window === "undefined") {
    throw new Error("PDF extraction is only supported in the browser.");
  }

  try {
    const [pdfjs, workerUrl] = await Promise.all([
      import("pdfjs-dist"),
      // eslint-disable-next-line import/no-unresolved -- Vite `?url` asset import
      import("pdfjs-dist/build/pdf.worker.min.mjs?url").then((m) => m.default),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

    const data = await file.arrayBuffer();
    /* Give pdf.js its own copy: it transfers the ArrayBuffer to its worker
       (detaching it), but we still need the original bytes to build the OCR
       data URL below. */
    const loadingTask = pdfjs.getDocument({ data: data.slice(0) });
    const doc = await loadingTask.promise;

    const pages: string[] = [];
    let anyImagePage = false;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .trim();
      pages.push(pageText);

      /* Image-only pages (scanned PDFs, printed LaTeX, etc.) have no text
         layer. Detect the presence of painted image objects so we know to
         route this file through OCR rather than use the (empty) text layer. */
      if (!pageText && (await hasImageOperator(page, pdfjs.OPS))) {
        anyImagePage = true;
      }
      page.cleanup();
    }
    await loadingTask.destroy();

    const text = pages.join("\n\n").trim();
    const name = fileName(file);
    const needsOcr = text.length === 0 && anyImagePage;
    return {
      text,
      title: name ? titleFromFilename(name) : undefined,
      meta: { filename: name, pages: pages.length },
      ...(needsOcr
        ? { needsOcr: true, fileDataUrl: bytesToDataUrl(data, "application/pdf") }
        : {}),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Couldn't extract text from that PDF (${reason}).`);
  }
}
