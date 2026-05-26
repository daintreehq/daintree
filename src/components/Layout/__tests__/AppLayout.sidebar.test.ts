import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const APP_LAYOUT_PATH = path.resolve(__dirname, "../AppLayout.tsx");
const SIDEBAR_PATH = path.resolve(__dirname, "../Sidebar.tsx");

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

  it("computes effectiveAssistantWidth directly from visible assistant state", () => {
    expect(source).toContain(
      "const effectiveAssistantWidth = showAssistant ? layout.helpPanelWidth : 0"
    );
    // The slot must not stay reserved until a timer fires. That caused the
    // Assistant to slide out, then disappear, instead of matching the
    // worktree sidebar's simultaneous grid-over-sidebar motion.
    expect(source).not.toContain("assistantSlotReserved");
  });

  it("mounts HelpPanel unconditionally inside a flex-reserved sidebar slot (issue #6619, #6816)", () => {
    // The old conditional-render guard (which destroyed the PTY on every
    // toggle) must not be reintroduced.
    expect(source).not.toMatch(/\{layout\.helpPanelOpen && \(\s*\n\s*<ErrorBoundary[^>]*HelpPanel/);
    expect(source).toMatch(
      /<HelpPanel\s+width=\{layout\.helpPanelWidth\}\s+isVisible=\{showAssistant\}\s+isReadyToLaunch=\{isHydrated\}/
    );
    // The Assistant must remain a structural flex sibling that reserves
    // horizontal space instead of reverting to an overlay on top of terminals.
    expect(source).toContain('"relative h-full shrink-0 overflow-hidden"');
    expect(source).toContain("width: effectiveAssistantWidth");
    expect(source).not.toMatch(/"absolute top-0 right-0 bottom-0 z-30"/);
  });

  it("clips a full-width Assistant while the right sidebar slot animates like the worktree sidebar", () => {
    // The Assistant content stays full width and pinned to the viewport edge.
    // The flex slot width animates underneath it, so the panel grid slides
    // over the Assistant instead of the Assistant floating over terminals.
    expect(source).toContain("isReadyToLaunch={isHydrated}");
    expect(source).toContain("transition-[width]");
    expect(source).toContain('className="absolute top-0 right-0 h-full"');
    expect(source).not.toContain("translate-x-full");
    // The effective slot width must not be passed as the content width; that
    // would resize the Assistant contents instead of clipping/revealing them.
    expect(source).not.toContain("<HelpPanel width={effectiveAssistantWidth}");
  });

  it("uses showAssistant for the macro-focus assistant visibility effect", () => {
    expect(source).toContain('setVisibility("assistant", showAssistant)');
    expect(source).toContain("[showAssistant]");
  });

  it("publishes --portal-right-offset as portal-only (issue #6800)", () => {
    // The Assistant is a flex sibling below the toolbar — it doesn't overlay
    // the toolbar. Toolbar dropdowns must dodge the Portal (body-portaled web
    // chat) but not the Assistant. The previous shared-max value pushed
    // dropdowns left by Assistant width even when the Portal was closed.
    expect(source).toMatch(/setProperty\("--portal-right-offset", `\$\{portalOffset\}px`\)/);
    // The portal-only var must not be re-conflated with Assistant width.
    expect(source).not.toMatch(/setProperty\("--portal-right-offset",[^)]*Math\.max\(portalOffset/);
  });

  it("publishes --right-obstruction-offset as max(portal, assistant) (issue #6629)", () => {
    // Portal overlays Assistant when both are open, so the rightmost fixed
    // obstruction is max(portal, assistant), not their sum. Toaster, popovers,
    // ReEntrySummary, GettingStartedChecklist, and the ThemeBrowser overlay
    // all read this var — they're body-portaled fixed elements that would
    // otherwise be hidden behind the wider of the two panels.
    expect(source).toContain("Math.max(portalOffset, effectiveAssistantWidth)");
    expect(source).toMatch(
      /setProperty\("--right-obstruction-offset", `\$\{obstructionOffset\}px`\)/
    );
    expect(source).toMatch(/\[layout\.portalOpen, layout\.portalWidth, effectiveAssistantWidth\]/);
    // The old sum semantics must not be reintroduced.
    expect(source).not.toMatch(/portalOffset \+ effectiveAssistantWidth/);
  });

  it("removes both right-edge vars on cleanup", () => {
    expect(source).toContain('removeProperty("--portal-right-offset")');
    expect(source).toContain('removeProperty("--right-obstruction-offset")');
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

describe("AppLayout drag-resize transition gating — issue #7627", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("imports flushSync so the gating class is removed before the first mousemove", () => {
    // React 19 batches state updates. Without flushSync, setIsSidebarResizing
    // doesn't reach the DOM until the next render, which can leave one eased
    // frame at the start of the drag. flushSync forces the class strip to
    // happen synchronously inside the mousedown handler.
    expect(source).toContain('import { createPortal, flushSync } from "react-dom"');
  });

  it("tracks per-panel drag-resize state in AppLayout", () => {
    expect(source).toContain("const [isSidebarResizing, setIsSidebarResizing] = useState(false)");
    expect(source).toContain(
      "const [isAssistantResizing, setIsAssistantResizing] = useState(false)"
    );
  });

  it("flushes the resize-start setter so the transition class disappears before mousemove", () => {
    expect(source).toMatch(/flushSync\(\(\)\s*=>\s*setIsSidebarResizing\(true\)\)/);
    expect(source).toMatch(/flushSync\(\(\)\s*=>\s*setIsAssistantResizing\(true\)\)/);
  });

  it("gates both width transitions on the resize state, preserving them otherwise", () => {
    // The 250ms ease-out-expo transition is kept (it animates collapse/expand
    // and double-click reset) but suppressed during active drag-resize so the
    // edge tracks the cursor without the per-mousemove ease.
    expect(source).toMatch(/!reduceAnimations\s*&&\s*!isSidebarResizing\s*&&/);
    expect(source).toMatch(/!reduceAnimations\s*&&\s*!isAssistantResizing\s*&&/);
    // The transition string must remain specific to width — never widened to
    // bare `transition` or `transition-all`. Past lesson #4738.
    expect(source).toContain("transition-[width]");
    expect(source).not.toMatch(/"\s*transition\s+/);
    expect(source).not.toContain("transition-all");
  });

  it("wires resize-lifecycle callbacks into Sidebar and HelpPanel", () => {
    expect(source).toMatch(/<Sidebar[\s\S]*?onResizeStart=\{handleSidebarResizeStart\}/);
    expect(source).toMatch(/<Sidebar[\s\S]*?onResizeEnd=\{handleSidebarResizeEnd\}/);
    expect(source).toMatch(/<HelpPanel[\s\S]*?onResizeStart=\{handleAssistantResizeStart\}/);
    expect(source).toMatch(/<HelpPanel[\s\S]*?onResizeEnd=\{handleAssistantResizeEnd\}/);
  });

  it("does not call the toggle-only suppression machinery on drag-resize", () => {
    // Past lesson #4170: suppressSidebarResizes / lockSidebarLayoutTransition
    // are timed for the fixed 250ms toggle animation. Calling them on drag
    // would prevent the final PTY dimension flush and lock the transition for
    // an unrelated window. Drag-resize must not invoke them.
    expect(source).not.toMatch(/handleSidebarResizeStart[\s\S]{0,200}suppressSidebarResizes/);
    expect(source).not.toMatch(/handleAssistantResizeStart[\s\S]{0,200}suppressSidebarResizes/);
  });
});

describe("Sidebar unmount-mid-drag safety net — issue #7627", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_PATH, "utf-8");
  });

  it("mirrors isResizing through a ref so unmount cleanup can read latest state", () => {
    // The state-flag closure captured by the listener-attaching effect's
    // cleanup closes over the OLD value of isResizing (true) on every run,
    // so it can't tell graceful end from teardown. A ref updated inside
    // startResizing/stopResizing gives the unmount cleanup a synchronous
    // signal of the live drag state.
    expect(source).toMatch(/const isResizingRef = useRef\(false\)/);
    expect(source).toMatch(/isResizingRef\.current = true/);
    expect(source).toMatch(/isResizingRef\.current = false/);
  });

  it("calls onResizeEnd on unmount if a drag is still in progress", () => {
    // Without this, project switching while the user is mid-drag (which
    // unmounts Sidebar via AppLayout's `currentProject != null` guard)
    // would leave AppLayout's `isSidebarResizing` flag stuck true forever,
    // silently disabling the collapse/expand animation for the rest of
    // the session.
    // The prop is mirrored through a ref so the unmount-only effect's
    // deps can stay empty without disabling exhaustive-deps.
    expect(source).toMatch(/const onResizeEndRef = useRef\(onResizeEnd\)/);
    expect(source).toMatch(
      /if \(isResizingRef\.current\)[\s\S]{0,120}onResizeEndRef\.current\?\.\(\)/
    );
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
      '"fixed top-12 right-0 bottom-0 z-50 shadow-2xl border-l border-daintree-border"'
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

describe("AppLayout CSS layout containment — issue #9014", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("applies contain: layout paint to the resizable sidebar wrapper", () => {
    // The sidebar column wrapper carries dynamic inline width and is the direct
    // drag-resize target. `contain: layout paint` isolates child layout/paint
    // recalc to this subtree during continuous resize instead of invalidating
    // the whole page. `layout paint` (not `strict`/`size`) is deliberate — size
    // containment would break the flex column sizing.
    expect(source).toMatch(/width:\s*effectiveSidebarWidth,[\s\S]{0,160}contain:\s*"layout paint"/);
    // Size containment (strict/size) would collapse the flex column to 0×0.
    expect(source).not.toContain('contain: "strict"');
    expect(source).not.toMatch(/contain:\s*"[^"]*size/);
  });

  it("gives the contained sidebar wrapper a z-index so the resize handle stays visible", () => {
    // The contain boundary turns the sidebar wrapper into a stacking context.
    // Its resize handle overhangs the right edge by 6px (-right-1.5, z-50);
    // without an explicit z-index the wrapper paints below the later <main>
    // sibling (both z-index auto, DOM order wins) and <main>'s opaque
    // background occludes the handle overhang.
    expect(source).toMatch(/contain:\s*"layout paint",[\s\S]{0,400}zIndex:\s*1/);
  });

  it("preserves the sidebar wrapper's overflow-clip-margin alongside containment", () => {
    // `contain: paint` converts overflow:visible to overflow:clip at used-value
    // time and honors overflow-clip-margin per spec — the existing 6px margin
    // must stay intact so the sidebar's edge decorations aren't clipped tight.
    expect(source).toContain('overflowClipMargin: "6px"');
    expect(source).toMatch(
      /overflowClipMargin:\s*"6px",[\s\S]{0,40}contain:\s*"layout paint"|contain:\s*"layout paint",[\s\S]{0,40}overflowClipMargin:\s*"6px"/
    );
  });

  it("applies contain: layout paint to the resizable assistant wrapper", () => {
    expect(source).toMatch(/width:\s*effectiveAssistantWidth,\s*contain:\s*"layout paint"/);
  });
});
