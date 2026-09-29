import { describe, expect, it } from "vitest";
import { formatCopyResultMessage } from "../formatCopyResult";

describe("formatCopyResultMessage", () => {
  it("agrees the noun with a single file", () => {
    expect(formatCopyResultMessage({ fileCount: 1 })).toBe("Copied 1 file to clipboard");
    expect(formatCopyResultMessage({ fileCount: 1 }, "terminal")).toBe(
      "Injected 1 file into terminal"
    );
  });

  it("pluralizes and groups larger counts", () => {
    expect(formatCopyResultMessage({ fileCount: 2 })).toBe("Copied 2 files to clipboard");
    expect(formatCopyResultMessage({ fileCount: 1204 }, "temporary-file")).toBe(
      `Bundled ${(1204).toLocaleString()} files into a temporary file`
    );
  });
});
