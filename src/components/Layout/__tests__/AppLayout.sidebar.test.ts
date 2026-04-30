import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const APP_LAYOUT_PATH = path.resolve(__dirname, "../AppLayout.tsx");

describe("AppLayout sidebar visibility — issue #5023 hide on welcome screen", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("derives showSidebar from isFocusMode and currentProject", () => {
    expect(source).toContain("const showSidebar = !layout.isFocusMode && currentProject != null");
  });

  it("mounts the sidebar whenever a project is active so the width transition can run", () => {
    // Issue #5697: the sidebar stays mounted in focus mode (width=0) so the
    // CSS width transition runs instead of an abrupt unmount. The render guard
    // is now `currentProject != null`; visibility is driven by width via
    // effectiveSidebarWidth and by macro focus via setVisibility(showSidebar).
    expect(source).toMatch(/\{currentProject != null && \(\s*\n\s*<ErrorBoundary[^>]*Sidebar/);
    // The old unmount-in-focus-mode guard must not be reintroduced.
    expect(source).not.toMatch(/\{showSidebar && \(\s*\n\s*<ErrorBoundary[^>]*Sidebar/);
    expect(source).not.toMatch(/\{!layout\.isFocusMode && \(\s*\n\s*<ErrorBoundary[^>]*Sidebar/);
  });

  it("uses showSidebar for the macro-focus sidebar visibility effect", () => {
    expect(source).toContain('setVisibility("sidebar", showSidebar)');
    expect(source).toContain("[showSidebar]");
    // The old bare isFocusMode dependency should not drive sidebar visibility
    expect(source).not.toMatch(/setVisibility\("sidebar",\s*!layout\.isFocusMode\)/);
  });
});
