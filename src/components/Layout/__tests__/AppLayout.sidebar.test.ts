import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const APP_LAYOUT_PATH = path.resolve(__dirname, "../AppLayout.tsx");

describe("AppLayout sidebar visibility — issue #5023 hide on welcome screen", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("derives showSidebar from gestureSidebarHidden and currentProject (issue #6659)", () => {
    expect(source).toContain(
      "const showSidebar = !layout.gestureSidebarHidden && currentProject != null"
    );
    // The combined isFocusMode gate must not be reintroduced — the sidebar
    // visibility must be independent from the assistant.
    expect(source).not.toContain("const showSidebar = !layout.isFocusMode && currentProject");
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

  it("derives showAssistant from gestureAssistantHidden and helpPanelOpen (issue #6659)", () => {
    expect(source).toContain(
      "const showAssistant = !layout.gestureAssistantHidden && layout.helpPanelOpen"
    );
    // The combined isFocusMode gate must not be reintroduced — the assistant
    // visibility must be independent from the worktree sidebar.
    expect(source).not.toContain(
      "const showAssistant = !layout.isFocusMode && layout.helpPanelOpen"
    );
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
      /<ErrorBoundary[^>]*componentName="HelpPanel"[^>]*>\s*\n\s*<HelpPanel\s+width=\{effectiveAssistantWidth\}\s*\/>/
    );
  });

  it("passes effectiveAssistantWidth to HelpPanel so focus mode collapses width to 0", () => {
    // Without the prop, HelpPanel reads its own store and ignores focus mode,
    // leaving the panel at full width when the user enters focus mode.
    expect(source).toContain("<HelpPanel width={effectiveAssistantWidth} />");
  });

  it("uses showAssistant for the macro-focus assistant visibility effect", () => {
    expect(source).toContain('setVisibility("assistant", showAssistant)');
    expect(source).toContain("[showAssistant]");
  });

  it("uses max of portal and assistant widths for --portal-right-offset (issue #6629)", () => {
    // Portal overlays Assistant when both are open, so the rightmost fixed
    // obstruction is max(portal, assistant), not their sum. The previous sum
    // logic over-displaced toasts/popovers when both panels were open.
    expect(source).toContain("Math.max(portalOffset, effectiveAssistantWidth)");
    expect(source).toContain("--portal-right-offset");
    expect(source).toMatch(/\[layout\.portalOpen, layout\.portalWidth, effectiveAssistantWidth\]/);
    // The old sum semantics must not be reintroduced.
    expect(source).not.toMatch(/portalOffset \+ effectiveAssistantWidth/);
  });
});

describe("AppLayout independent sidebar gestures — issue #6659", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("Toolbar sidebar button drives only the worktree sidebar gesture", () => {
    // The toolbar's sidebar toggle must reflect/control gestureSidebarHidden
    // specifically — not the combined isFocusMode flag, which would also flip
    // when only the assistant is suppressed.
    expect(source).toContain("isFocusMode={layout.gestureSidebarHidden}");
    expect(source).toContain("onToggleFocusMode={handleToggleSidebar}");
  });

  it("worktree-sidebar toggle uses setSidebarGestureHidden, not the combined toggle", () => {
    expect(source).toContain("focus.setSidebarGestureHidden(!focus.gestureSidebarHidden");
  });

  it("listens for daintree:toggle-sidebar separately from daintree:toggle-focus-mode", () => {
    expect(source).toContain('addEventListener("daintree:toggle-sidebar"');
    expect(source).toContain('addEventListener("daintree:toggle-focus-mode"');
  });

  it("persists the sidebar-specific gesture flag, not the combined isFocusMode", () => {
    // The legacy `focusMode` boolean in per-project state always meant
    // "sidebar hidden by chrome gesture". Persisting the combined flag would
    // leak the assistant's transient state across reloads.
    expect(source).toContain("const persistedFocusMode = layout.gestureSidebarHidden");
  });
});

describe("AppLayout portal viewport coverage — issue #6629", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("renders PortalDock via body portal so it covers the full viewport width", () => {
    // Issue #6629: when the Assistant became a flex sibling of <main> in
    // PR #6620, the Portal (rendered as `absolute right-0` inside <main>)
    // stopped at the Assistant's left edge. Body-portaling with `position:
    // fixed` lets the Portal escape <main>'s width and overlay the Assistant.
    expect(source).toMatch(/\{layout\.portalOpen &&\s*\n\s*createPortal\(/);
    expect(source).toContain(
      '"fixed top-0 right-0 bottom-0 z-50 shadow-2xl border-l border-daintree-border"'
    );
    // The portal target must be document.body to escape the inert subtrees and
    // the <main> width constraint. A different target would silently reintroduce
    // the bug.
    expect(source).toMatch(
      /\{layout\.portalOpen &&\s*\n\s*createPortal\([\s\S]+?<PortalDock \/>[\s\S]+?document\.body\s*\)/
    );
    // The old in-<main> absolute wrapper must not be reintroduced.
    expect(source).not.toContain(
      '"absolute right-0 top-0 bottom-0 z-50 shadow-2xl border-l border-daintree-border"'
    );
  });

  it("disables the Portal chrome when the ThemeBrowser overlay is open", () => {
    // Body-portaling moved the PortalDock out of the inert main-content
    // wrapper, so the inert prop must be applied directly to the new wrapper.
    // Without this, the Portal tabs / toolbar / resize handle remain clickable
    // through the ThemeBrowser overlay (Portal is z-50, ThemeBrowser is z-40).
    expect(source).toMatch(
      /\{layout\.portalOpen &&\s*\n\s*createPortal\([\s\S]+?isThemeBrowserOpen \? \{ inert: true \} : \{\}[\s\S]+?<PortalDock \/>/
    );
  });
});
