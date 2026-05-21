// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("ContentDock regression test", () => {
  it("does not import or render ClusterAttentionPill", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).not.toContain("ClusterAttentionPill");
    expect(content).not.toContain('from "@/components/Fleet"');
  });

  it("renders from resolved dock items instead of raw tab-group shells", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toContain("const dockItems = useMemo");
    expect(content).toContain("dockItems.length === 0");
    expect(content).not.toContain("if (groupPanels.length === 0) return null");
  });

  it("offscreen dock container closes stale active dock state", () => {
    const content = readFileSync(resolve(__dirname, "../DockPanelOffscreenContainer.tsx"), "utf-8");

    expect(content).toContain("activeDockTerminalId");
    expect(content).toContain("closeDockTerminal()");
    expect(content).toContain("!s.trashedTerminals.has(t.id)");
  });

  it("renders the visible DockLaunchButton wired to handleAddTerminal", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toContain("DockLaunchButton");
    expect(content).toContain("agents={launchAgents}");
    expect(content).toMatch(/onLaunchAgent=\{[^}]*handleAddTerminal/);
    expect(content).toContain("hasDevPreview={hasDevPreview}");
  });

  it("places the launch button on the left side of the dock", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    const launchIdx = content.indexOf("<DockLaunchButton");
    const trashIdx = content.indexOf("<TrashContainer");

    expect(launchIdx).toBeGreaterThan(0);
    expect(launchIdx).toBeLessThan(trashIdx);
  });

  // Issue #6428 — accent ring on isOver was a restraint violation; replace with neutral.
  it("uses a neutral ring on dock isOver state (no accent)", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).not.toContain("ring-daintree-accent");
    expect(content).toMatch(/isOver\s*&&\s*[^]*?ring-border-default/);
  });

  // Issue #8162 — drop the ambient in-flight rail tint; the only drag-state cue
  // is the armed isOver treatment, plus a cursor-no-drop rejection signal for
  // worktree-card sort drags that can't drop on the dock.
  it("removes ambient panel-drag tint and adds worktree-sort cursor feedback", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).not.toContain("useIsDragging");
    expect(content).not.toContain('isPanelDragging && "bg-overlay-subtle"');
    expect(content).toContain('isWorktreeSortDragging && "cursor-no-drop"');
    expect(content).toMatch(/isOver\s*&&\s*[^]*?cursor-copy/);
  });

  // Issue #6590 — handleAddTerminal must rely on the atomic dock activation
  // flag instead of a follow-up openDockTerminal() call, otherwise the
  // watchdog effect collapses the freshly created panel.
  it("handleAddTerminal passes activateDockOnCreate and does not call openDockTerminal", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toContain("activateDockOnCreate: true");
    expect(content).not.toContain("openDockTerminal(result.result.terminalId)");
    expect(content).not.toMatch(/openDockTerminal\(result\.result\?\.terminalId\)/);
  });

  // Issue #6590 — DockPanelOffscreenContainer.handleAddTabForPanel must use
  // the atomic flag too. The same race that collapses dock-launched agents
  // also collapses the just-created tab in a single-panel-to-tab-group flow.
  it("DockPanelOffscreenContainer add-tab flow uses atomic dock activation", () => {
    const content = readFileSync(resolve(__dirname, "../DockPanelOffscreenContainer.tsx"), "utf-8");

    expect(content).toContain("activateDockOnCreate: true");
    expect(content).not.toContain("openDockTerminal(newPanelId)");
  });

  // Issue #7979 — dock context menu must surface a "Dock density" submenu
  // wired to the same preference store the Settings dialog uses, so users
  // can switch density in place without leaving the dock.
  it("renders a Dock density submenu wired to setDockDensity", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toContain("ContextMenuSub");
    expect(content).toContain("ContextMenuSubTrigger");
    expect(content).toContain("ContextMenuSubContent");
    expect(content).toContain("ContextMenuRadioGroup");
    expect(content).toContain("ContextMenuRadioItem");
    expect(content).toContain("Dock density");
  });

  it("subscribes to setDockDensity from usePreferencesStore", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toMatch(/usePreferencesStore\(\(s\)\s*=>\s*s\.setDockDensity\)/);
  });

  it("offers the three density options compact, normal, and comfortable", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toContain('value: "compact"');
    expect(content).toContain('value: "normal"');
    expect(content).toContain('value: "comfortable"');
  });

  it("places the density submenu after DockLaunchMenuItems with a separator", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    const launchIdx = content.indexOf("<DockLaunchMenuItems");
    const separatorIdx = content.indexOf("<ContextMenuSeparator />", launchIdx);
    const subIdx = content.indexOf("<ContextMenuSub>", launchIdx);

    expect(launchIdx).toBeGreaterThan(0);
    expect(separatorIdx).toBeGreaterThan(launchIdx);
    expect(subIdx).toBeGreaterThan(separatorIdx);
  });

  // Issue #7278 — the watchdog effect in DockPanelOffscreenContainer must
  // check panelsById before firing closeDockTerminal, so that a panel that
  // exists in canonical storage but hasn't landed in the filtered
  // dockTerminals view yet isn't spuriously collapsed.
  it("DockPanelOffscreenContainer watchdog guards with panelsById before closing", () => {
    const content = readFileSync(resolve(__dirname, "../DockPanelOffscreenContainer.tsx"), "utf-8");

    expect(content).toContain("usePanelStore.getState().panelsById[activeDockTerminalId]");
    // The panelsById guard must appear before closeDockTerminal() inside the
    // same useEffect block.
    const effectStart = content.indexOf("if (!activeDockTerminalId) return;");
    const panelsByIdGuard = content.indexOf("panelsById[activeDockTerminalId]");
    const closeCall = content.indexOf("closeDockTerminal()", effectStart);

    expect(effectStart).toBeGreaterThan(0);
    expect(panelsByIdGuard).toBeGreaterThan(effectStart);
    expect(panelsByIdGuard).toBeLessThan(closeCall);
  });

  // Issue #8170 — the scrollable chip rail is an ARIA toolbar with a single
  // tab stop and roving tabindex Arrow/Home/End navigation. dnd-kit's
  // KeyboardSensor owns the keys during an active drag; the rail handler
  // must early-return when useDndContext().active != null. Focusing an
  // off-screen chip scrolls it into view with behavior:"instant".
  describe("keyboard navigation — issue #8170", () => {
    it("marks the scrollable rail as an ARIA toolbar", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toContain('role="toolbar"');
      expect(content).toContain('aria-label="Docked terminals"');
      expect(content).toContain('aria-orientation="horizontal"');
    });

    it("flips aria-busy on the rail while a dnd-kit drag is active", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toMatch(/const\s+\{\s*active:\s*dndActive\s*\}\s*=\s*useDndContext\(\)/);
      expect(content).toContain("const isDndActive = dndActive !== null");
      expect(content).toContain("aria-busy={isDndActive || undefined}");
    });

    it("queries [data-dock-item] chips inside the scroll container", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toContain('querySelectorAll<HTMLElement>("[data-dock-item]")');
      expect(content).toContain("offsetParent !== null");
    });

    it("uses a ref (not state) for the active dock index", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toContain("activeDockIndexRef = useRef(0)");
    });

    it("syncs roving tab stops via useLayoutEffect", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toContain("useLayoutEffect");
      expect(content).toContain("syncDockTabStops");
      // Clamp matches Toolbar.tsx pattern when chips are added/removed.
      expect(content).toMatch(/Math\.min\(activeDockIndexRef\.current,\s*items\.length\s*-\s*1\)/);
    });

    it("wires onKeyDown and onFocusCapture to the rail container", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toContain("onKeyDown={handleDockKeyDown}");
      expect(content).toContain("onFocusCapture={handleDockFocusCapture}");
    });

    it("early-returns the key handler when dnd-kit has an active drag", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      // The guard must appear inside handleDockKeyDown, before any
      // preventDefault or arrow-key handling.
      const handlerStart = content.indexOf("handleDockKeyDown = useCallback");
      const guard = content.indexOf("if (dndActive !== null) return", handlerStart);
      const switchStart = content.indexOf("switch (e.key)", handlerStart);

      expect(handlerStart).toBeGreaterThan(0);
      expect(guard).toBeGreaterThan(handlerStart);
      expect(guard).toBeLessThan(switchStart);
    });

    it("handles Arrow/Home/End with wrap and preventDefault inside the switch", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toContain('case "ArrowRight"');
      expect(content).toContain('case "ArrowLeft"');
      expect(content).toContain('case "Home"');
      expect(content).toContain('case "End"');
      // Wrap arithmetic on both ends.
      expect(content).toMatch(/\(currentIdx \+ 1\) % items\.length/);
      expect(content).toMatch(/\(currentIdx - 1 \+ items\.length\) % items\.length/);
    });

    it("focuses then scrolls instantly — focus must precede scrollIntoView", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toContain('scrollIntoView({ behavior: "instant"');
      expect(content).toContain('block: "nearest"');
      expect(content).toContain('inline: "nearest"');

      // .focus() must come before scrollIntoView in handleDockKeyDown so the
      // browser's own scroll-on-focus does not override the explicit call.
      const handlerStart = content.indexOf("handleDockKeyDown = useCallback");
      const focusCall = content.indexOf("target.focus()", handlerStart);
      const scrollCall = content.indexOf("target.scrollIntoView", handlerStart);

      expect(focusCall).toBeGreaterThan(0);
      expect(scrollCall).toBeGreaterThan(focusCall);
    });

    it("preserves data-dock-item attribute on chip buttons", () => {
      const terminalItem = readFileSync(resolve(__dirname, "../DockedTerminalItem.tsx"), "utf-8");
      const tabGroup = readFileSync(resolve(__dirname, "../DockedTabGroup.tsx"), "utf-8");

      expect(terminalItem).toContain('data-dock-item=""');
      expect(tabGroup).toContain('data-dock-item=""');
    });
  });
});
