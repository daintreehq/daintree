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

  // Issue #11332 — dock membership must follow the registry so plugin panels can
  // dock. The dock selectors read `getRenderablePanel` (which keeps plugin
  // kinds), NOT `getNarrowPanel` (which drops them, so plugin panels would never
  // reach `isDockPanel`). Reverting either call site silently strands every
  // dockable plugin panel, so pin the selector here.
  it("reads dock panels through getRenderablePanel so plugin kinds are not dropped", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    // Target the call sites (not prose) so a doc mention can't mask a revert.
    expect(content).toContain("getRenderablePanel(state.panelsById");
    expect(content).not.toContain("getNarrowPanel(state.panelsById");
  });

  // Issue #11332 — the single-panel chip renders through the generic
  // `DockedNonPtyPanelItem` with a kind-aware `dockChipTitle`, replacing the old
  // three-way ternary whose `else` branch assumed browser and would mislabel a
  // plugin panel's chip.
  it("renders non-PTY dock chips through the generic dockChipTitle path", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toContain("displayTitle={dockChipTitle(terminal)}");
    // The removed branch fed browserChipTitle to the ternary's non-file else.
    expect(content).not.toMatch(/:\s*isFilePanel\(terminal\)\s*\?/);
  });

  it("offscreen dock container closes stale active dock state", () => {
    const content = readFileSync(resolve(__dirname, "../DockPanelOffscreenContainer.tsx"), "utf-8");

    expect(content).toContain("activeDockTerminalId");
    expect(content).toContain("closeDockTerminal(activeDockTerminalId)");
    expect(content).toContain("!s.trashedTerminals.has(t.id)");
  });

  it("renders the visible DockLaunchButton wired to handleAddTerminal", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).toContain("DockLaunchButton");
    expect(content).toContain("agents={launchAgents}");
    expect(content).toMatch(/onLaunchAgent=\{[^}]*handleAddTerminal/);
    // #11521 — the dock creates panels in the dock, so both of its launcher
    // surfaces must declare that. A grid surface here would offer dock
    // destinations the dock's own callback would then contradict.
    expect(content).toContain('surface="dock"');
    expect(content).not.toContain('surface="grid"');
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

    expect(content).not.toContain("ring-accent-primary");
    expect(content).toMatch(/isOver\s*&&\s*[^]*?ring-border-default/);
  });

  // Issue #8162 — drop the ambient in-flight rail tint; the only drag-state cue
  // is the armed isOver treatment, plus a cursor-no-drop rejection signal.
  // Issue #11054 — the rejection cue also fires for a drag whose panel kind the
  // dock can't render, not just worktree-card sort drags, via the shared
  // `isDockDropRejected` gate. Both cases suppress the armed isOver treatment.
  // Issue #11375 — the non-dockable check is now GROUP-AWARE: it reads
  // `activeDragRejectsDock` off the placeholder context (which resolves every
  // group member's kind), not the lone representative kind, so the cue matches
  // what cancelDrop/collisionDetection enforce for a mixed group.
  it("removes ambient panel-drag tint and rejects non-dockable drags with cursor feedback", () => {
    const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

    expect(content).not.toContain("useIsDragging");
    expect(content).not.toContain('isPanelDragging && "bg-overlay-subtle"');
    expect(content).toContain('isDockDropRejected && "cursor-no-drop"');
    // The reject gate folds in the group-aware dock-reject flag from the context.
    expect(content).toContain("activeDragRejectsDock");
    expect(content).toMatch(/isDockDropRejected\s*=\s*isWorktreeSortDragging\s*\|\|/);
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
    // The panelsById guard must appear before the close call inside the
    // same useEffect block.
    const effectStart = content.indexOf("if (!activeDockTerminalId) return;");
    const panelsByIdGuard = content.indexOf("panelsById[activeDockTerminalId]");
    const closeCall = content.indexOf("closeDockTerminal(activeDockTerminalId)", effectStart);

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
      expect(content).toContain('aria-label="Docked panels"');
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

  // Issue #9681 — when the focused chip unmounts, the roving-tabindex
  // useLayoutEffect re-homes the tab stop but focus has already dropped to
  // <body>, killing keyboard navigation. The dock mirrors Toolbar.tsx's
  // prevFocusedToolbarItemRef recovery: track the focused chip, and on
  // eviction redirect focus onto the promoted chip — but only when focus
  // genuinely fell to <body> (not into a Radix portal). Two further fixes:
  // the scroll chevrons are decorative pointer-only controls and must leave
  // the tab order, and the scroll container needs scroll-padding so focused
  // edge chips are not parked behind the gradient scrim.
  describe("focus recovery — issue #9681", () => {
    it("tracks the previously focused chip in a dedicated ref", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toContain("prevFocusedDockItemRef = useRef<HTMLElement | null>(null)");
      // The recovery ref sits alongside the existing roving-index ref.
      const indexRefIdx = content.indexOf("activeDockIndexRef = useRef");
      const focusRefIdx = content.indexOf("prevFocusedDockItemRef = useRef");
      expect(indexRefIdx).toBeGreaterThan(0);
      expect(focusRefIdx).toBeGreaterThan(indexRefIdx);
    });

    it("records the focused chip in handleDockFocusCapture", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      // The assignment must live inside handleDockFocusCapture's idx-found
      // branch so the ref always reflects the live focused chip.
      const handlerStart = content.indexOf("handleDockFocusCapture = useCallback");
      const assign = content.indexOf("prevFocusedDockItemRef.current = target", handlerStart);
      const handlerEnd = content.indexOf("handleDockKeyDown = useCallback", handlerStart);

      expect(handlerStart).toBeGreaterThan(0);
      expect(assign).toBeGreaterThan(handlerStart);
      expect(assign).toBeLessThan(handlerEnd);
    });

    it("redirects focus to the promoted chip only when focus fell to <body>", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      // Eviction detection: prev focused chip no longer in the live list.
      expect(content).toMatch(/if\s*\(prevFocused\s*&&\s*!items\.includes\(prevFocused\)\)/);
      // The portal guard must gate the .focus() call.
      const guard = content.indexOf("document.activeElement === document.body");
      const focusCall = content.indexOf("items[clamped]?.focus()");
      expect(guard).toBeGreaterThan(0);
      expect(focusCall).toBeGreaterThan(guard);
    });

    it("clears the recovery ref unconditionally on eviction (before the body guard)", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      // A stale ref would trigger a phantom redirect on a later unrelated
      // render, so the clear must precede the activeElement guard.
      const clear = content.indexOf("prevFocusedDockItemRef.current = null");
      const guard = content.indexOf("document.activeElement === document.body");
      expect(clear).toBeGreaterThan(0);
      expect(guard).toBeGreaterThan(clear);
    });

    it("removes the scroll chevrons from the tab order", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      // Both decorative chevron buttons must carry tabIndex={-1} + aria-hidden.
      const tabIndexCount = (content.match(/tabIndex=\{-1\}/g) ?? []).length;
      expect(tabIndexCount).toBeGreaterThanOrEqual(2);

      // Anchor each aria-hidden to its chevron's label so the assertion can't
      // pass on an unrelated pre-existing aria-hidden elsewhere in the file.
      const leftBtn = content.indexOf("onClick={scrollLeft}");
      const leftLabel = content.indexOf('aria-label="Scroll left"', leftBtn);
      expect(content.slice(leftBtn, leftLabel)).toContain('aria-hidden="true"');

      const rightBtn = content.indexOf("onClick={scrollRight}");
      const rightLabel = content.indexOf('aria-label="Scroll right"', rightBtn);
      expect(content.slice(rightBtn, rightLabel)).toContain('aria-hidden="true"');
    });

    it("applies scroll-padding so focused edge chips clear the gradient scrim", () => {
      const content = readFileSync(resolve(__dirname, "../ContentDock.tsx"), "utf-8");

      expect(content).toContain("scroll-px-4");
    });
  });
});
