import { describe, expect, it } from "vitest";
import {
  getRenderedMarkdownAvailability,
  isRenderedMarkdownSupported,
  type RenderedMarkdownAvailabilityInput,
} from "../renderedMarkdownAvailability";

function input(
  overrides: Partial<RenderedMarkdownAvailabilityInput> = {}
): RenderedMarkdownAvailabilityInput {
  return {
    filePath: "docs/guide.md",
    diffSource: "working-tree",
    content: "@@ -1 +1 @@\n-a\n+b",
    stale: false,
    sourceErrorCode: null,
    engineFailure: null,
    ...overrides,
  };
}

describe("isRenderedMarkdownSupported", () => {
  it("covers every extension the markdown surfaces already recognise", () => {
    for (const path of ["a.md", "a.markdown", "a.mdx", "a.mkd", "A.MD"]) {
      expect(isRenderedMarkdownSupported(path, "working-tree")).toBe(true);
    }
  });

  it("is false for a non-markdown file and for a missing path", () => {
    expect(isRenderedMarkdownSupported("src/index.ts", "working-tree")).toBe(false);
    expect(isRenderedMarkdownSupported(undefined, "working-tree")).toBe(false);
  });

  it("follows the disk-backed sources, treating a missing source as working-tree", () => {
    expect(isRenderedMarkdownSupported("a.md", undefined)).toBe(true);
    expect(isRenderedMarkdownSupported("a.md", "unstaged")).toBe(true);
    expect(isRenderedMarkdownSupported("a.md", "staged")).toBe(false);
    expect(isRenderedMarkdownSupported("a.md", "base-branch")).toBe(false);
  });
});

describe("getRenderedMarkdownAvailability", () => {
  it("hides the segment entirely for a non-markdown file", () => {
    expect(getRenderedMarkdownAvailability(input({ filePath: "src/index.ts" }))).toEqual({
      visible: false,
    });
  });

  it("enables it for a working-tree markdown diff", () => {
    expect(getRenderedMarkdownAvailability(input())).toEqual({ visible: true, enabled: true });
  });

  it("stays enabled while the diff is still loading", () => {
    expect(getRenderedMarkdownAvailability(input({ content: undefined }))).toEqual({
      visible: true,
      enabled: true,
    });
  });

  it("disables staged and base-branch diffs, saying which", () => {
    const staged = getRenderedMarkdownAvailability(input({ diffSource: "staged" }));
    const base = getRenderedMarkdownAvailability(input({ diffSource: "base-branch" }));

    expect(staged.visible && !staged.enabled && staged.reason).toContain("staged changes");
    expect(base.visible && !base.enabled && base.reason).toContain("base-branch");
  });

  it("disables a stale diff, because the reconstruction trusts the gaps between hunks", () => {
    const result = getRenderedMarkdownAvailability(input({ stale: true }));

    expect(result.visible && !result.enabled && result.reason).toBe(
      "Refresh the diff before rendering the current Markdown"
    );
  });

  it("disables on a failed whole-file read, quoting the read error", () => {
    const result = getRenderedMarkdownAvailability(input({ sourceErrorCode: "FILE_TOO_LARGE" }));

    expect(result.visible && !result.enabled && result.reason).toContain(
      "Rendered Markdown needs the current file:"
    );
  });

  it("disables on each diff sentinel with its own reason", () => {
    const reasons = ["NO_CHANGES", "ERROR", "BINARY_FILE", "FILE_TOO_LARGE"].map((content) => {
      const result = getRenderedMarkdownAvailability(input({ content }));
      return result.visible && !result.enabled ? result.reason : null;
    });

    expect(reasons.every((reason) => typeof reason === "string" && reason.length > 0)).toBe(true);
    expect(new Set(reasons).size).toBe(4);
  });

  it("disables on the engine's verdict once it has one", () => {
    const result = getRenderedMarkdownAvailability(input({ engineFailure: "source-mismatch" }));

    expect(result.visible && !result.enabled && result.reason).toBe(
      "The file changed after this diff loaded — refresh to render it"
    );
  });

  it("ranks staleness above the engine's verdict, since refreshing is the fix for both", () => {
    const result = getRenderedMarkdownAvailability(
      input({ stale: true, engineFailure: "source-mismatch" })
    );

    expect(result.visible && !result.enabled && result.reason).toContain("Refresh the diff");
  });
});
