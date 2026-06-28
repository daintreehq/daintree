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

  it("mounts HelpPanel unconditionally and reserves its space with a layout spacer (issue #6619, #6816)", () => {
    // The old conditional-render guard (which destroyed the PTY on every
    // toggle) must not be reintroduced.
    expect(source).not.toMatch(/\{layout\.helpPanelOpen && \(\s*\n\s*<ErrorBoundary[^>]*HelpPanel/);
    expect(source).toMatch(
      /<HelpPanel\s+width=\{layout\.helpPanelWidth\}\s+isVisible=\{showAssistant\}\s+isReadyToLaunch=\{isHydrated\}/
    );
    // The Assistant must reserve horizontal space (push the grid) rather than
    // float over terminals. Under the off-canvas model (#10693) a sibling layout
    // spacer is the structural flex element reserving the slot width; the panel
    // slides over that reserved space via transform, never over the grid. The
    // old z-30 floating-overlay form must not return.
    expect(source).toMatch(
      /aria-hidden[\s\S]*?shrink-0[\s\S]*?style=\{\{ width: effectiveAssistantWidth \}\}/
    );
    expect(source).not.toMatch(/"absolute top-0 right-0 bottom-0 z-30"/);
  });

  it("lazily defines and eagerly preloads HelpPanel (issue #10389)", () => {
    // HelpPanel (~175KB source subtree) must not be in the eager entry chunk.
    expect(source).not.toMatch(/import \{ HelpPanel \} from/);
    expect(source).toContain('function preloadHelpPanel() {\n  return import("../HelpPanel");');
    // Named `HelpPanel` (not Lazy*) so the JSX assertions above keep matching.
    expect(source).toContain("const HelpPanel = lazy(");
    // The render is unconditional, so the chunk is always needed — it must be
    // in-flight at module evaluation, not after first mount.
    expect(source).toContain("void preloadHelpPanel();");
  });

  it("keeps the Assistant content full width while the slot animates (issue #10693 off-canvas)", () => {
    // The Assistant content stays full width and pinned to the viewport edge;
    // the wrapper slides off-canvas via transform while the spacer's width
    // animates the <main> push. The content must never be resized to the slot
    // width — that would reflow the terminal, which is the orphaned-row bug.
    expect(source).toContain("isReadyToLaunch={isHydrated}");
    expect(source).toContain("transition-[width]");
    expect(source).toContain('className="absolute top-0 right-0 h-full"');
    // The slot must not be hidden with a Tailwind translate utility (which would
    // animate via class swap rather than the gated inline transform).
    expect(source).not.toContain("translate-x-full");
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

  it("disables the Portal chrome when a full-screen overlay is open", () => {
    // Body-portaling moved the PortalDock out of the inert main-content
    // wrapper, so the inert prop must be applied directly to the new wrapper.
    // Without this, the Portal tabs / toolbar / resize handle remain clickable
    // through the ThemeBrowser overlay (Portal is z-50, ThemeBrowser is z-40).
    // Since #9558 the same guard also covers the plugin-manager overlay via the
    // shared `chromeInert` signal.
    expect(source).toMatch(
      /\{layout\.portalOpen &&\s*\n\s*createPortal\([\s\S]+?chromeInert \? \{ inert: true \} : \{\}[\s\S]+?<PortalDock \/>/
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
    // time and honors overflow-clip-margin per spec — the 6px margin must stay
    // intact (while visible/animating) so the sidebar's resize-handle overhang
    // isn't clipped tight. Issue #9864 made it a ternary that drops to 0px once
    // fully hidden, so the margin literal now lives in the ternary, adjacent to
    // the containment declaration.
    expect(source).toContain('"0px" : "6px"');
    expect(source).toMatch(
      /overflowClipMargin:\s*sidebarFullyHidden \? "0px" : "6px",[\s\S]{0,200}contain:\s*"layout paint"/
    );
  });

  it("applies contain: layout paint to the off-canvas assistant wrapper", () => {
    // The wrapper now animates transform (off-canvas slide, #10693) at a
    // constant width; containment stays on it to isolate the slide's layout and
    // paint from the rest of the row. Issue #9014.
    expect(source).toMatch(/transform: showAssistant[\s\S]{0,300}contain:\s*"layout paint"/);
  });
});

describe("AppLayout sidebar clip-margin state machine — issue #9864", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("initializes sidebarFullyHidden from !showSidebar so no 6px strip flashes on startup", () => {
    // overflow-clip-margin is discrete, so a wrong initial value paints a 6px
    // strip on the first frame when the app boots with the sidebar hidden.
    expect(source).toContain(
      "const [sidebarFullyHidden, setSidebarFullyHidden] = useState(() => !showSidebar)"
    );
  });

  it("drives the wrapper's overflowClipMargin from sidebarFullyHidden, not a static literal", () => {
    expect(source).toContain('overflowClipMargin: sidebarFullyHidden ? "0px" : "6px"');
    // The old unconditional 6px must not linger — that was the bug.
    expect(source).not.toMatch(/overflowClipMargin:\s*"6px",/);
  });

  it("clears sidebarFullyHidden immediately on show so the handle overhang precedes the reveal", () => {
    // The clip margin must be restored before the open animation, not after it,
    // otherwise the resize handle is clipped off during the reveal.
    expect(source).toMatch(
      /if \(showSidebar\)\s*\{\s*\n[\s\S]{0,200}setSidebarFullyHidden\(false\)/
    );
  });

  it("zeroes the clip margin only after the width transition ends, filtered to the wrapper's own width", () => {
    // overflow-clip-margin is discrete — zeroing it at transition start would
    // snap the handle off mid-slide. onTransitionEnd is the canonical
    // completion signal (past lessons #4170/#6982/#7826). It must filter on
    // propertyName === "width" and target === currentTarget to ignore bubbled
    // child transitions, and re-check !showSidebar to ignore a reversed hide.
    expect(source).toContain("onTransitionEnd={handleSidebarTransitionEnd}");
    expect(source).toMatch(/event\.propertyName === "width"/);
    expect(source).toMatch(/event\.target === event\.currentTarget/);
    expect(source).toMatch(
      /handleSidebarTransitionEnd = useCallback\([\s\S]{0,700}!showSidebar[\s\S]{0,120}setSidebarFullyHidden\(true\)/
    );
  });

  it("flushes sidebarFullyHidden synchronously when no transition will fire transitionend", () => {
    // With reduceAnimations, an active drag-resize, or OS-level reduced motion
    // (motion-reduce:transition-none), the width transition never runs, so
    // transitionend never fires. The hide path must flush the state directly,
    // else the 6px strip persists for reduced-motion users until re-show.
    expect(source).toMatch(/window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
    expect(source).toMatch(
      /reduceAnimations \|\|\s*isSidebarResizing \|\|\s*isSidebarWidthHydrating \|\|\s*prefersReducedMotion \|\|\s*layout\.performanceMode[\s\S]{0,80}setSidebarFullyHidden\(true\)/
    );
  });

  it("includes performanceMode in the synchronous-flush guard and its deps", () => {
    // data-performance-mode narrows transition-property to exclude width
    // (src/index.css), so the width transitionend never fires. Without this the
    // 6px strip persists in performance mode — the original #9864 regression.
    expect(source).toMatch(/\|\|\s*layout\.performanceMode/);
    expect(source).toMatch(
      /\[\s*showSidebar,\s*reduceAnimations,\s*isSidebarResizing,\s*isSidebarWidthHydrating,\s*layout\.performanceMode,?\s*\]/
    );
  });
});

describe("AppLayout sidebar-width hydration transition gating — issue #10321", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("tracks an initially-suppressed hydration flag so the boot width-restore doesn't animate", () => {
    // sidebarWidth boots at DEFAULT_SIDEBAR_WIDTH and is replaced once the async
    // appClient.getState() restore resolves ~50-100ms later. Starting the flag
    // at true keeps the width transition off until that restore lands, so the
    // late setSidebarWidth doesn't animate 350px -> persisted on project switch.
    expect(source).toContain(
      "const [isSidebarWidthHydrating, setIsSidebarWidthHydrating] = useState(true)"
    );
  });

  it("gates the sidebar width transition on the hydration flag alongside the resize guard", () => {
    // The new flag must join the existing gate, not replace it — drag-resize
    // suppression (#7627) and reduced-motion must still hold.
    expect(source).toMatch(
      /!reduceAnimations\s*&&\s*!isSidebarResizing\s*&&\s*!isSidebarWidthHydrating\s*&&/
    );
  });

  it("clears the hydration flag in both the restore success and failure paths", () => {
    // Unconditional clear in the try block (after the getState restore) so a
    // session without a persisted width still re-enables the transition, and a
    // clear in catch so a failed IPC doesn't permanently suppress every later
    // user resize/collapse.
    // One clear inside the try (before the catch) and one inside the catch.
    expect(source).toMatch(
      /setIsSidebarWidthHydrating\(false\);[\s\S]*?\} catch \(error\) \{[\s\S]*?setIsSidebarWidthHydrating\(false\)/
    );
    // Both clears must live within the restoreState effect's try/catch, not the
    // initial useState — so there are exactly two setter calls total.
    expect(source.match(/setIsSidebarWidthHydrating\(false\)/g)?.length).toBe(2);
  });

  it("does not need flushSync to clear the flag — the post-await batch is enough", () => {
    // Unlike drag-resize start (which races the first mousemove), the clear runs
    // in the same synchronous continuation as setSidebarWidth after the await,
    // so React batches both into one paint. A flushSync here would be wrong.
    expect(source).not.toMatch(/flushSync\([^)]*setIsSidebarWidthHydrating/);
  });
});

describe("AppLayout grid-measurement hydration unlock — issue #10827", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("imports the hydration unlock from the layout-transition lock module", () => {
    expect(source).toContain("unlockSidebarHydration");
    expect(source).toContain('from "@/lib/layoutTransitionLock"');
  });

  it("releases the hydration lock in an effect once the hydrating flag clears", () => {
    // The passive effect runs after React commits the restored sidebarWidth (and
    // the cleared flag) into the DOM, so grid/pane measurement subscribers fire
    // against the correct <main> width instead of the default 350px.
    expect(source).toMatch(
      /if \(!isSidebarWidthHydrating\)\s*\{\s*unlockSidebarHydration\(\);\s*return;\s*\}/
    );
  });

  it("gates the unlock on isHydrated so the pre-hydration skeleton can't release the lock early", () => {
    // App.tsx renders a skeleton <AppLayout isHydrated={false}> (no ContentGrid)
    // whose fast appClient.getState() typically resolves before the real layout
    // mounts. Without this gate the skeleton would unlock the global lock early,
    // so the real grid would hit the already-unlocked fast path and measure at
    // the default 350px — reproducing the snap.
    expect(source).toMatch(/if \(!isHydrated\) return;[\s\S]{0,500}unlockSidebarHydration\(\)/);
    expect(source).toMatch(/\}, \[isHydrated, isSidebarWidthHydrating\]\)/);
  });

  it("arms a fallback unlock so a hung width-restore IPC still measures the grid", () => {
    // If appClient.getState() neither resolves nor rejects, isSidebarWidthHydrating
    // stays true forever; the timeout releases the lock so the grid degrades to a
    // visible (pre-#10827) state rather than never measuring. Cleared the instant
    // the flag clears normally.
    expect(source).toMatch(
      /setTimeout\(\s*unlockSidebarHydration,\s*SIDEBAR_HYDRATION_UNLOCK_FALLBACK_MS\s*\)/
    );
    expect(source).toMatch(/clearTimeout\(fallback\)/);
  });
});
