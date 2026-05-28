import { describe, it, expect } from "vitest";
import {
  sanitizePartitionToken,
  buildDevPreviewPartition,
  isDevPreviewPartition,
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

  it("falls back to 'default' when sanitization yields an empty string", () => {
    expect(sanitizePartitionToken("@@@")).toBe("-");
    expect(sanitizePartitionToken("")).toBe("default");
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
