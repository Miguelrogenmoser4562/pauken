import { describe, it, expect } from "vitest";
import { ingestText } from "./text";
import { ingest } from "./index";

describe("ingestText", () => {
  it("trims surrounding whitespace", () => {
    const result = ingestText("  \n\nHello world\nmore text  \n\n");
    expect(result.text).toBe("Hello world\nmore text");
  });

  it("derives the title from the first non-empty line", () => {
    const result = ingestText("\n\n  My Title Line  \nBody text follows");
    expect(result.title).toBe("My Title Line");
  });

  it("caps the derived title at 80 chars", () => {
    const longLine = "x".repeat(120);
    const result = ingestText(longLine);
    expect(result.title).toHaveLength(80);
  });

  it("has no title for empty/whitespace-only text", () => {
    const result = ingestText("   \n  \n");
    expect(result.text).toBe("");
    expect(result.title).toBeUndefined();
  });
});

describe("ingest() routing", () => {
  it("routes 'blank' to empty text", async () => {
    const result = await ingest({ kind: "blank" });
    expect(result).toEqual({ text: "" });
  });

  it("routes 'text' through ingestText", async () => {
    const result = await ingest({ kind: "text", text: "  Hello there\nmore  " });
    expect(result.text).toBe("Hello there\nmore");
    expect(result.title).toBe("Hello there");
  });

  it("treats a missing text field as empty input", async () => {
    const result = await ingest({ kind: "text" });
    expect(result.text).toBe("");
    expect(result.title).toBeUndefined();
  });

  it("routes 'audio' to needsTranscription with the blob attached", async () => {
    const blob = new Blob(["fake audio bytes"], { type: "audio/mpeg" });
    const result = await ingest({ kind: "audio", file: blob, filename: "lecture.mp3" });
    expect(result.needsTranscription).toBe(true);
    expect(result.text).toBe("");
    expect(result.audio).toBe(blob);
    expect(result.meta?.filename).toBe("lecture.mp3");
  });

  it("rejects 'url' ingestion without a url", async () => {
    await expect(ingest({ kind: "url" })).rejects.toThrow();
  });

  it("rejects 'pdf' ingestion without a file", async () => {
    await expect(ingest({ kind: "pdf" })).rejects.toThrow();
  });

  it("rejects 'docx' ingestion without a file", async () => {
    await expect(ingest({ kind: "docx" })).rejects.toThrow();
  });
});
