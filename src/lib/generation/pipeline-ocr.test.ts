/* @vitest-environment jsdom */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Engine, EngineCapabilities, CompletionOptions, TokenHandler, OcrOptions } from "../engine/types";
import { Repo } from "../db";
import { memoryStore } from "../db/memory";
import { createNoteFromSources } from "./pipeline";

/* Mock pdfjs so a "pdf" input produces an image-only page -> needsOcr. */
const h = vi.hoisted(() => {
  const state = { numPages: 1, pageTexts: [""], pageHasImage: [true] };
  const OPS = { paintImageXObject: 1, paintJpegXObject: 2, paintImageMaskXObject: 3, paintInlineImageXObject: 4 };
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

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as never;
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,SCANPAGE") as never;
});

function scanFile(): File {
  return new File(["fake pdf bytes"], "scan.pdf", { type: "application/pdf" });
}

/* A generation-capable engine (complete/embed for the downstream note steps)
   whose vision + ocrImage behavior is configurable per test. */
function makeEngine(vision: boolean, log: string[]): Engine {
  return {
    mode: "cloud",
    provider: vision ? "openai" : "deepseek",
    capabilities: (): EngineCapabilities => ({ chat: true, embeddings: true, vision }),
    async complete(_opts: CompletionOptions, onToken?: TokenHandler): Promise<string> {
      const md = "# Overview\n\nOCR text becomes note content.";
      if (onToken) for (const ch of md) onToken(ch);
      return md;
    },
    async structured<T>(): Promise<T> {
      return {} as T;
    },
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => [0.1, 0.2, 0.3]);
    },
    async ocrImage(imageDataUrl: string, opts?: OcrOptions): Promise<string> {
      log.push(`${imageDataUrl}${opts?.filename ? "::" + opts.filename : ""}`);
      return "OCR $x^2 + y^2 = z^2$";
    },
    async validate(): Promise<void> {},
  };
}

describe("createNoteFromSources OCR path", () => {
  it("uses ocrEngine for OCR when the main engine lacks vision", async () => {
    const repo = new Repo(memoryStore());
    const ocrLog: string[] = [];
    const mainLog: string[] = [];
    const engine = makeEngine(false, mainLog);
    const ocrEngine = makeEngine(true, ocrLog);

    const id = await createNoteFromSources({
      repo,
      engine,
      ocrEngine,
      inputs: [{ kind: "pdf", file: scanFile(), filename: "scan.pdf" }],
      generateStudyTools: false,
    });

    expect(ocrLog.length).toBe(1);
    expect(ocrLog[0]).toMatch(/^data:application\/pdf;base64,/);
    expect(ocrLog[0]).toContain("::scan.pdf");
    expect(mainLog).toEqual([]);
    const note = await repo.getNote(id);
    expect(note!.sourceText).toContain("OCR $x^2 + y^2 = z^2$");
  });

  it("falls back to the main engine when it has vision and no ocrEngine is given", async () => {
    const repo = new Repo(memoryStore());
    const mainLog: string[] = [];
    const engine = makeEngine(true, mainLog);

    const id = await createNoteFromSources({
      repo,
      engine,
      inputs: [{ kind: "pdf", file: scanFile(), filename: "scan.pdf" }],
      generateStudyTools: false,
    });

    expect(mainLog.length).toBe(1);
    expect(mainLog[0]).toMatch(/^data:application\/pdf;base64,/);
    const note = await repo.getNote(id);
    expect(note!.sourceText).toContain("OCR $x^2 + y^2 = z^2$");
  });

  it("throws a clear error when no engine has vision", async () => {
    const repo = new Repo(memoryStore());
    const engine = makeEngine(false, []);
    const ocrEngine = makeEngine(false, []);

    await expect(
      createNoteFromSources({
        repo,
        engine,
        ocrEngine,
        inputs: [{ kind: "pdf", file: scanFile(), filename: "scan.pdf" }],
        generateStudyTools: false,
      }),
    ).rejects.toThrow(/no OCR engine is configured/i);
  });
});
