import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const LAYOUT_PATH = resolve(__dirname, "../TwoPaneSplitLayout.tsx");

describe("TwoPaneSplitLayout resize overlay removal (issue #4951)", () => {
  it("does not contain per-pane resize overlay", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");
    expect(content).not.toContain("Resizing...");
    expect(content).not.toContain("Overlay to hide terminal content during resize drag");
  });

  it("preserves viewport-level drag capture overlay", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");
    expect(content).toContain("createPortal");
    expect(content).toContain("col-resize");
  });

  it("preserves isDraggingDivider state and lockResize", async () => {
    const content = await readFile(LAYOUT_PATH, "utf-8");
    expect(content).toContain("isDraggingDivider");
    expect(content).toContain("lockResize");
  });
});
