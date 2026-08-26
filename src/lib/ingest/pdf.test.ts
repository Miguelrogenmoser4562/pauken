/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ingestPdf } from "./pdf";

/* Shared mutable test state + the pdfjs OPS enum values. Using vi.hoisted so
   the pdfjs-dist mock factory (hoisted above imports) can reference them. */
const h = vi.hoisted(() => {
  const state = {
    numPages: 1,
    pageTexts: [""],
    pageHasImage: [true],
  };
  const OPS = {
    paintImageXObject: 1,
    paintJpegXObject: 2,
    paintImageMaskXObject: 3,
    paintInlineImageXObject: 4,
  };
  return { state, OPS };
});

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  OPS: h.OPS,
  getDocument: () => ({
    promise: Promise.resolve({
      get numPages() {
        return h.state.numPages;
      },
      getPage: async (i: number) => ({
        getTextContent: async () => ({
          items: h.state.pageTexts[i - 1] ? [{ str: h.state.pageTexts[i - 1] }] : [],
        }),
        getOperatorList: async () => ({
          fnArray: h.state.pageHasImage[i - 1] ? [h.OPS.paintImageXObject] : [],
        }),
        getViewport: (v: { scale: number }) => ({ width: 100 * v.scale, height: 200 * v.scale }),
        render: () => ({ promise: Promise.resolve() }),
        cleanup: () => {},
      }),
    }),
    destroy: async () => {},
  }),
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "worker-url" }));

function fakePdf(text: string, hasImage = false): Blob {
  const file = new Blob(["fake pdf bytes"], { type: "application/pdf" });
  h.state.numPages = 1;
  h.state.pageTexts = [text];
  h.state.pageHasImage = [hasImage];
  return file;
}

beforeEach(() => {
  /* jsdom doesn't implement canvas 2d context — stub the surface we use. */
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as never;
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,AAAA") as never;
});

describe("ingestPdf", () => {
  it("returns extracted text for a text-layer PDF (no OCR)", async () => {
    const result = await ingestPdf(fakePdf("Hello world", false));
    expect(result.text).toBe("Hello world");
    expect(result.needsOcr).toBeUndefined();
    expect(result.fileDataUrl).toBeUndefined();
  });

  it("flags an image-only page for OCR and returns the PDF as a data URL", async () => {
    const result = await ingestPdf(fakePdf("", true));
    expect(result.text).toBe("");
    expect(result.needsOcr).toBe(true);
    expect(result.fileDataUrl).toMatch(/^data:application\/pdf;base64,/);
    expect(result.meta?.pages).toBe(1);
  });

  it("does not OCR when a page has empty text but no image operators", async () => {
    const result = await ingestPdf(fakePdf("", false));
    expect(result.text).toBe("");
    expect(result.needsOcr).toBeUndefined();
  });
});
