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

describe("AppLayout assistant push sidebar — issue #6619", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("derives showAssistant from isFocusMode and helpPanelOpen", () => {
    expect(source).toContain("const showAssistant = !layout.isFocusMode && layout.helpPanelOpen");
  });

  it("computes effectiveAssistantWidth so focus mode collapses the panel without unmounting", () => {
    expect(source).toContain(
      "const effectiveAssistantWidth = showAssistant ? layout.helpPanelWidth : 0"
    );
  });

  it("mounts HelpPanel unconditionally as a flex sibling so the xterm PTY survives close (issue #6619)", () => {
    // The old conditional-render guard (which destroyed the PTY on every
    // toggle) must not be reintroduced.
    expect(source).not.toMatch(/\{layout\.helpPanelOpen && \(\s*\n\s*<ErrorBoundary[^>]*HelpPanel/);
    expect(source).toMatch(
      /<ErrorBoundary[^>]*componentName="HelpPanel"[^>]*>\s*\n\s*<HelpPanel\s*\/>/
    );
  });

  it("uses showAssistant for the macro-focus assistant visibility effect", () => {
    expect(source).toContain('setVisibility("assistant", showAssistant)');
    expect(source).toContain("[showAssistant]");
  });

  it("sums portal and assistant widths into --portal-right-offset", () => {
    expect(source).toContain("portalOffset + effectiveAssistantWidth");
    expect(source).toContain("--portal-right-offset");
    expect(source).toMatch(/\[layout\.portalOpen, layout\.portalWidth, effectiveAssistantWidth\]/);
  });
});
