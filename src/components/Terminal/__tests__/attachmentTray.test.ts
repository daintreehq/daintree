import { describe, it, expect } from "vitest";
import { normalizeChips } from "../attachmentTrayUtils";

describe("normalizeChips", () => {
  it("returns empty array for empty inputs", () => {
    expect(normalizeChips([], [])).toEqual([]);
  });

  it("normalizes image entries with thumbnailUrl", () => {
    const images = [
      { from: 0, to: 5, filePath: "/tmp/img.png", thumbnailUrl: "data:image/png;base64,abc" },
    ];
    const result = normalizeChips(images, []);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("image");
    expect(result[0].thumbnailUrl).toBe("data:image/png;base64,abc");
    expect(result[0].label).toBe("Screenshot");
  });

  it("formats image label from clipboard timestamp", () => {
    const ts = new Date(2025, 0, 15, 14, 30).getTime();
    const images = [{ from: 0, to: 5, filePath: `/tmp/clipboard-${ts}-abc.png`, thumbnailUrl: "" }];
    const result = normalizeChips(images, []);
    expect(result[0].label).toBe("Screenshot 14:30");
  });

  it("normalizes file entries with fileSize", () => {
    const files = [{ from: 0, to: 5, fileName: "code.ts", fileSize: 2048 }];
    const result = normalizeChips([], files);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("file");
    expect(result[0].fileSize).toBe(2048);
    expect(result[0].label).toBe("code.ts");
  });

  it("handles file entries without fileSize", () => {
    const files = [{ from: 0, to: 5, fileName: "code.ts" }];
    const result = normalizeChips([], files);
    expect(result).toHaveLength(1);
    expect(result[0].fileSize).toBeUndefined();
  });

  it("preserves fileSize of zero", () => {
    const files = [{ from: 0, to: 5, fileName: "empty.txt", fileSize: 0 }];
    const result = normalizeChips([], files);
    expect(result[0].fileSize).toBe(0);
  });

  it("combines all chip types", () => {
    const images = [{ from: 0, to: 5, filePath: "/img.png", thumbnailUrl: "" }];
    const files = [{ from: 10, to: 15, fileName: "code.ts", fileSize: 1234 }];
    const result = normalizeChips(images, files);
    expect(result).toHaveLength(2);
  });

  it("sorts items by document position", () => {
    const images = [{ from: 20, to: 25, filePath: "/img.png", thumbnailUrl: "" }];
    const files = [{ from: 0, to: 5, fileName: "code.ts" }];
    const result = normalizeChips(images, files);
    expect(result.map((r) => r.kind)).toEqual(["file", "image"]);
  });
});
