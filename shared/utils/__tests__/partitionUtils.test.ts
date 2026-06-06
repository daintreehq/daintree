import { describe, it, expect } from "vitest";
import {
  sanitizePartitionToken,
  buildDevPreviewPartition,
  isDevPreviewPartition,
  buildBrowserPartition,
  isBrowserPartition,
} from "../partitionUtils.js";

describe("sanitizePartitionToken", () => {
  it("lowercases and trims", () => {
    expect(sanitizePartitionToken("  MyProject  ")).toBe("myproject");
  });

  it("replaces disallowed characters with hyphens and collapses runs", () => {
    expect(sanitizePartitionToken("a/b c@@d")).toBe("a-b-c-d");
  });

  it("preserves existing hyphens and underscores", () => {
    expect(sanitizePartitionToken("foo_bar-baz")).toBe("foo_bar-baz");
  });

  it("falls back to 'default' for undefined", () => {
    expect(sanitizePartitionToken(undefined)).toBe("default");
  });

  it("falls back to 'default' only when the result is genuinely empty", () => {
    expect(sanitizePartitionToken("")).toBe("default");
    expect(sanitizePartitionToken("   ")).toBe("default");
  });

  it("collapses all-delimiter input to a single safe delimiter token", () => {
    // Disallowed chars become hyphens then collapse; the result is non-empty so
    // it is kept as-is rather than replaced with 'default'.
    expect(sanitizePartitionToken("@@@")).toBe("-");
    expect(sanitizePartitionToken("___")).toBe("___");
    expect(sanitizePartitionToken("/ /")).toBe("-");
  });
});

describe("buildDevPreviewPartition", () => {
  it("composes the persist:dev-preview-* partition", () => {
    expect(buildDevPreviewPartition("proj", "wt", "panel")).toBe(
      "persist:dev-preview-proj-wt-panel"
    );
  });

  it("defaults the worktree token to 'main'", () => {
    expect(buildDevPreviewPartition("proj", undefined, "panel")).toBe(
      "persist:dev-preview-proj-main-panel"
    );
  });

  it("sanitizes each token", () => {
    expect(buildDevPreviewPartition("Pro/J", "Work Tree", "Panel#1")).toBe(
      "persist:dev-preview-pro-j-work-tree-panel-1"
    );
  });

  it("falls back to 'default' tokens when ids are missing", () => {
    expect(buildDevPreviewPartition(undefined, undefined, undefined)).toBe(
      "persist:dev-preview-default-main-default"
    );
  });
});

describe("isDevPreviewPartition", () => {
  it("accepts a well-formed dev-preview partition", () => {
    expect(isDevPreviewPartition("persist:dev-preview-proj-main-panel")).toBe(true);
    expect(isDevPreviewPartition(buildDevPreviewPartition("a", "b", "c"))).toBe(true);
  });

  it("rejects the default portal partition", () => {
    expect(isDevPreviewPartition("persist:portal")).toBe(false);
  });

  it("rejects non-persist or malformed partitions", () => {
    expect(isDevPreviewPartition("dev-preview-a-b-c")).toBe(false);
    expect(isDevPreviewPartition("persist:dev-preview-a-b")).toBe(false);
    expect(isDevPreviewPartition("persist:dev-preview-a-b-c!")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isDevPreviewPartition(undefined)).toBe(false);
    expect(isDevPreviewPartition(123)).toBe(false);
  });
});

describe("buildBrowserPartition", () => {
  it("composes the per-project persist:browser-* partition", () => {
    expect(buildBrowserPartition("proj")).toBe("persist:browser-proj");
  });

  it("sanitizes the project token", () => {
    expect(buildBrowserPartition("Pro/J #1")).toBe("persist:browser-pro-j-1");
  });

  it("falls back to a default token when the project id is missing", () => {
    expect(buildBrowserPartition(undefined)).toBe("persist:browser-default");
    expect(buildBrowserPartition("")).toBe("persist:browser-default");
  });

  it("always produces a scoped partition, never the legacy bare string", () => {
    expect(buildBrowserPartition(undefined)).not.toBe("persist:browser");
  });
});

describe("isBrowserPartition", () => {
  it("accepts a well-formed scoped browser partition", () => {
    expect(isBrowserPartition("persist:browser-my-project")).toBe(true);
    expect(isBrowserPartition(buildBrowserPartition("proj"))).toBe(true);
  });

  it("accepts the legacy bare browser partition", () => {
    expect(isBrowserPartition("persist:browser")).toBe(true);
  });

  it("rejects over-matching near-misses", () => {
    expect(isBrowserPartition("persist:browserish")).toBe(false);
    expect(isBrowserPartition("persist:browser/evil")).toBe(false);
    expect(isBrowserPartition("persist:dev-preview-browser-a")).toBe(false);
  });

  it("rejects other partition families", () => {
    expect(isBrowserPartition("persist:dev-preview-a-b-c")).toBe(false);
    expect(isBrowserPartition("persist:portal")).toBe(false);
    expect(isBrowserPartition("persist:daintree")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isBrowserPartition(undefined)).toBe(false);
    expect(isBrowserPartition(123)).toBe(false);
  });
});
