import { describe, it, expect } from "vitest";
import {
  normalizeChips,
  buildSummaryLine,
  getContextWindow,
  isWarningUsage,
} from "../attachmentTrayUtils";

describe("normalizeChips", () => {
  it("returns empty array for empty inputs", () => {
    expect(normalizeChips([], [], [])).toEqual([]);
  });

  it("normalizes image entries with flat token estimate", () => {
    const images = [{ from: 0, to: 5, filePath: "/tmp/img.png", thumbnailUrl: "" }];
    const result = normalizeChips(images, [], []);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("image");
    expect(result[0].tokenEstimate).toBe(1000);
    expect(result[0].label).toBe("Screenshot");
  });

  it("formats image label from clipboard timestamp", () => {
    const ts = new Date(2025, 0, 15, 14, 30).getTime();
    const images = [
      { from: 0, to: 5, filePath: `/tmp/clipboard-${ts}-abc.png`, thumbnailUrl: "" },
    ];
    const result = normalizeChips(images, [], []);
    expect(result[0].label).toBe("Screenshot 14:30");
  });

  it("normalizes file entries with flat token estimate", () => {
    const files = [{ from: 0, to: 5, filePath: "/tmp/code.ts", fileName: "code.ts" }];
    const result = normalizeChips([], files, []);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("file");
    expect(result[0].tokenEstimate).toBe(500);
    expect(result[0].label).toBe("code.ts");
  });

  it("uses url entry tokenEstimate directly", () => {
    const urls = [
      { from: 0, to: 10, title: "Docs", tokenEstimate: 3500, sourceUrl: "https://example.com" },
    ];
    const result = normalizeChips([], [], urls);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("url");
    expect(result[0].tokenEstimate).toBe(3500);
    expect(result[0].label).toBe("Docs");
  });

  it("falls back to sourceUrl when title is empty", () => {
    const urls = [
      { from: 0, to: 10, title: "", tokenEstimate: 100, sourceUrl: "https://example.com" },
    ];
    const result = normalizeChips([], [], urls);
    expect(result[0].label).toBe("https://example.com");
  });

  it("combines all chip types", () => {
    const images = [{ from: 0, to: 5, filePath: "/img.png", thumbnailUrl: "" }];
    const files = [{ from: 10, to: 15, filePath: "/code.ts", fileName: "code.ts" }];
    const urls = [
      { from: 20, to: 30, title: "Page", tokenEstimate: 2000, sourceUrl: "https://x.com" },
    ];
    const result = normalizeChips(images, files, urls);
    expect(result).toHaveLength(3);
  });

  it("sorts items by document position", () => {
    const images = [{ from: 20, to: 25, filePath: "/img.png", thumbnailUrl: "" }];
    const files = [{ from: 0, to: 5, filePath: "/code.ts", fileName: "code.ts" }];
    const urls = [
      { from: 10, to: 15, title: "Page", tokenEstimate: 2000, sourceUrl: "https://x.com" },
    ];
    const result = normalizeChips(images, files, urls);
    expect(result.map((r) => r.kind)).toEqual(["file", "url", "image"]);
  });
});

describe("buildSummaryLine", () => {
  it("shows single image correctly", () => {
    const items = [
      { id: "img-0-5", kind: "image" as const, label: "Screenshot", tokenEstimate: 1000, from: 0, to: 5 },
    ];
    expect(buildSummaryLine(items)).toBe("1 image \u00b7 ~1,000 tokens");
  });

  it("pluralizes correctly", () => {
    const items = [
      { id: "f-0-5", kind: "file" as const, label: "a.ts", tokenEstimate: 500, from: 0, to: 5 },
      { id: "f-10-15", kind: "file" as const, label: "b.ts", tokenEstimate: 500, from: 10, to: 15 },
    ];
    expect(buildSummaryLine(items)).toBe("2 files \u00b7 ~1,000 tokens");
  });

  it("omits zero-count categories", () => {
    const items = [
      { id: "u-0-10", kind: "url" as const, label: "Page", tokenEstimate: 2000, from: 0, to: 10 },
    ];
    expect(buildSummaryLine(items)).toBe("1 URL \u00b7 ~2,000 tokens");
  });

  it("joins multiple categories with middle dot", () => {
    const items = [
      { id: "img-0-5", kind: "image" as const, label: "Screenshot", tokenEstimate: 1000, from: 0, to: 5 },
      { id: "f-10-15", kind: "file" as const, label: "a.ts", tokenEstimate: 500, from: 10, to: 15 },
    ];
    expect(buildSummaryLine(items)).toBe("1 image \u00b7 1 file \u00b7 ~1,500 tokens");
  });
});

describe("getContextWindow", () => {
  it("returns 200000 for claude", () => {
    expect(getContextWindow("claude")).toBe(200_000);
  });

  it("returns 1000000 for gemini", () => {
    expect(getContextWindow("gemini")).toBe(1_000_000);
  });

  it("returns 128000 for codex", () => {
    expect(getContextWindow("codex")).toBe(128_000);
  });

  it("returns fallback for unknown agent", () => {
    expect(getContextWindow("unknown-agent")).toBe(128_000);
  });

  it("returns fallback for undefined agent", () => {
    expect(getContextWindow(undefined)).toBe(128_000);
  });
});

describe("isWarningUsage", () => {
  it("returns true at 80% threshold", () => {
    expect(isWarningUsage(80_000, 100_000)).toBe(true);
  });

  it("returns true above 80%", () => {
    expect(isWarningUsage(90_000, 100_000)).toBe(true);
  });

  it("returns false below 80%", () => {
    expect(isWarningUsage(79_000, 100_000)).toBe(false);
  });
});
