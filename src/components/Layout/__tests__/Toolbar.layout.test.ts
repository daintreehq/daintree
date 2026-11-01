import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { readToolbarCss } from "@/__tests__/support/cssManifest";
import { readToolbarSource } from "./toolbarSource";

const BUTTON_PATH = path.resolve(__dirname, "../../ui/button.tsx");

describe("Toolbar layout — issue #2584 project switcher collision", () => {
  let source: string;

  beforeEach(async () => {
    source = await readToolbarSource();
  });

  describe("Header container", () => {
    it("does not use flex justify-between on the toolbar root", () => {
      // The toolbar root should no longer use flex+justify-between (the old collision-prone pattern)
      expect(source).not.toMatch(/role="toolbar"[^>]*justify-between/);
    });
  });

  describe("Center group", () => {
    it("does not use absolute positioning", () => {
      // Absolute left-1/2 was the root cause of collision
      expect(source).not.toContain("absolute left-1/2");
      expect(source).not.toContain("-translate-x-1/2");
    });
  });

  describe("ARIA toolbar structure — issue #2814", () => {
    it("toolbar root has role=toolbar and aria-label", () => {
      expect(source).toMatch(/role="toolbar"/);
      expect(source).toMatch(/aria-label="Main toolbar"/);
    });

    it("has three role=group regions", () => {
      const groupMatches = source.match(/role="group"/g);
      expect(groupMatches).not.toBeNull();
      expect(groupMatches!.length).toBe(3);
    });

    it("groups have descriptive aria-labels", () => {
      expect(source).toContain('aria-label="Navigation and agents"');
      expect(source).toContain('aria-label="Project"');
      expect(source).toContain('aria-label="Tools and settings"');
    });

    it("has onKeyDown handler for arrow navigation", () => {
      expect(source).toContain("onKeyDown={handleToolbarKeyDown}");
    });

    it("has onFocusCapture handler for focus tracking", () => {
      expect(source).toContain("onFocusCapture={handleToolbarFocusCapture}");
    });
  });

  describe("Agent/tool button group divider — issues #2879, #11681", () => {
    // The divider positions themselves are covered for real in
    // toolbarButtonGrouping.test.ts — these only assert that Toolbar.tsx is
    // still wired to that declared-group algorithm rather than deriving
    // boundaries locally, which this file (a source scan) is the only place
    // that can check.
    it("resolves each button's group against the live plugin registry", () => {
      // The membership argument is what keeps a contribution from inheriting a
      // built-in's placement — a bare `getToolbarButtonGroup(id)` would compile
      // and silently misplace every promoted plugin button.
      expect(source).toMatch(/getToolbarButtonGroup\(\s*id,\s*pluginConfigs\.has\(id\)\s*\)/);
    });

    it("no longer derives boundaries from an agent/non-agent predicate", () => {
      expect(source).not.toContain("AGENT_TOOLBAR_IDS");
    });

    it("places dividers from the visible set, not from every available button", () => {
      // Passing `() => true` here would restore a divider after an
      // overflow-evicted button.
      expect(source).toMatch(
        /getToolbarDividerAfterIds\(\s*available,\s*\(id\) => visibleSet\.has\(id\),/
      );
    });

    it("has one grouped renderer that inserts group dividers", () => {
      expect(source).toContain("renderGroupedButtons");
      // The old right-side renderer drew no dividers and read the persisted
      // order; both sides go through the grouped one now.
      expect(source).not.toMatch(/const renderButtons\s*=/);
    });

    it("divider element has aria-hidden for accessibility", () => {
      expect(source).toMatch(/group-divider[\s\S]{0,200}aria-hidden="true"/);
    });
  });

  describe("Composition of the extracted modules — issue #14347", () => {
    // Every guard here reads the toolbar's modules as one surface, so it would
    // still pass on a hook nothing calls. Toolbar.tsx itself has to wire them.
    it("calls each extracted hook and renders the overflow menu", async () => {
      const shell = await fs.readFile(path.resolve(__dirname, "../Toolbar.tsx"), "utf-8");
      for (const call of [
        "useToolbarItemPlacement({",
        "useToolbarOverflowStatus({",
        "useToolbarOverflowEviction({",
        "useToolbarCustomization({",
        "useToolbarProjectPill({",
        "<OverflowMenu",
      ]) {
        expect(shell).toContain(call);
      }
    });

    it("keys eviction on measured overflow and the demoted set, not the merged lists", async () => {
      const shell = await fs.readFile(path.resolve(__dirname, "../Toolbar.tsx"), "utf-8");
      expect(shell).toMatch(
        /useToolbarOverflowEviction\(\{\s*measuredLeftOverflow,\s*measuredRightOverflow,\s*demotedIds,/
      );
    });
  });

  describe("Empty-space context menu — issue #12355", () => {
    // The menu's behaviour is covered for real in ToolbarButtonsContextMenu and
    // toolbarVisibilityMenu tests; these only pin Toolbar.tsx's wiring to it.
    it("hands the menu the toolbar root itself, which it clones rather than wraps", () => {
      expect(source).toMatch(
        /<ToolbarButtonsContextMenu[^>]*>\s*<div\s+ref=\{toolbarRef\}\s+role="toolbar"/
      );
    });

    it("builds the rows from the side lists before the visibility filter", () => {
      // Built from `effective*Buttons` instead, a hidden button would drop out of
      // the one menu that exists to bring it back.
      // The right list adds this project's tray-only plugin buttons in project
      // mode (#13783), on top of the same pre-filter side list.
      expect(source).toMatch(
        /buildToolbarVisibilityMenuRows\(\s*positionedLeftButtons,\s*menuRightButtons/
      );
      expect(source).toMatch(
        /const menuRightButtons = useMemo\([\s\S]*?return positionedRightButtons;/
      );
    });

    it("routes a menu toggle through the helper Settings → Toolbar uses", () => {
      expect(source).toMatch(/setToolbarButtonOnToolbar\(\s*buttonId,\s*side,\s*onToolbar,/);
    });
  });

  describe("Window resize strip — issue #3273 Linux native title bar", () => {
    it("window-resize-strip is guarded by !isLinux()", () => {
      expect(source).toMatch(/!isLinux\(\)\s*&&\s*<div className="window-resize-strip"/);
    });

    it("window-resize-strip is not rendered unconditionally", () => {
      expect(source).not.toMatch(/^\s*<div className="window-resize-strip"\s*\/>/m);
    });
  });

  describe("Project switcher trigger", () => {
    it("can drop the branch chip out of the layout entirely — issue #11084", () => {
      // A scratch workspace has no branch, and a merely-faded chip still reserves
      // blank width beside the name. So the chip must be conditionally mounted, not
      // unconditionally rendered and hidden. Which of the four states applies to a
      // given workspace is `branchChipState`'s contract, unit-tested in
      // src/lib/__tests__/workspaceIdentity.test.ts — here we only prove the pill is
      // wired to it and can still reserve width without showing a branch.
      const chipIndex = source.indexOf('"toolbar-project-chip inline-flex');
      expect(chipIndex).toBeGreaterThan(-1);
      const beforeChip = source.slice(Math.max(0, chipIndex - 1200), chipIndex);
      expect(beforeChip).toMatch(/chipState !== "hidden"\s*&&\s*\(/);

      // What the reserved chip looks like — a placeholder bone, not a transparent
      // box — is asserted by rendering it, in ToolbarProjectPill.test.tsx.
      // The chip must never mount straight off the branch: that collapses the pill
      // for a branchless project too, which is the titlebar shift 88e295a07 fixed.
      expect(source).not.toMatch(
        /\{branchName\s*&&\s*\(?\s*<span[\s\S]{0,120}toolbar-project-chip/
      );
    });

    it("pill label comes from the active workspace, never brand text", () => {
      // The label strings themselves now live in `activeWorkspaceIdentity`; the
      // empty-state wording is asserted in its own suite.
      expect(source).toContain("{workspaceIdentity.name}");
      expect(source).not.toContain("Daintree");
    });

    it("project switcher button takes its accessible label from the active workspace", () => {
      // Plus the branch the chip shows: the button's own label wins over
      // anything inside it, so the chip cannot carry the branch itself.
      expect(source).toContain("aria-label={`${workspaceIdentity.ariaLabel}${chipSpoken}`}");
    });
  });

  describe("Titlebar drag regions — secondary window project hydration", () => {
    it("keeps project-scoped toolbar controls in the first-paint button set", () => {
      expect(source).toContain("PROJECT_SCOPED_TOOLBAR_IDS");
      expect(source).toContain('"dev-server", "forge-stats"');
      expect(source).not.toContain("isAvailable: !!currentProject");
    });

    it("renders inert placeholders before a project is available", () => {
      expect(source).toContain("ForgeStatsPlaceholder");
      expect(source).toContain("DevServerPlaceholder");
      expect(source).toContain("data-toolbar-placeholder");
      expect(source).toContain("!currentProject && PROJECT_SCOPED_TOOLBAR_IDS.has(id)");
      expect(source).toContain("opacity-0 pointer-events-none");
    });

    it("reserves the loaded GitHub stats width before counts arrive", () => {
      expect(source).toContain("w-[13rem] shrink-0");
      expect(source.match(/<div data-stat-segment="" className="h-8 flex-1" \/>/g)).toHaveLength(3);
    });

    it("marks the whole project switcher grid cell as no-drag", () => {
      // Assert the load-bearing tokens on the center group, not the literal
      // class string — a copied string forces the same edit as the source on
      // any unrelated styling change.
      const centerGroup = /aria-label="Project"[\s\S]{0,400}?className="([^"]+)"/.exec(source)?.[1];
      expect(centerGroup).toBeDefined();
      expect(centerGroup).toContain("app-no-drag");
      expect(centerGroup).toContain("pointer-events-none");
      // The identity trigger is absolutely positioned against this cell.
      expect(centerGroup).toContain("relative");
    });
  });

  describe("Windows caption control spacer — issues #7951 / #8167", () => {
    it("does not inline navigator.platform checks", () => {
      expect(source).not.toContain("navigator.platform");
    });

    it("guards the trailing spacer with isWindows()", () => {
      expect(source).toMatch(/isWindows\(\)\s*&&\s*\(/);
    });

    it("sizes the spacer from the shared caption-width constant", () => {
      // Issue #11766: the old env(titlebar-area-width, …) expression could only
      // ever resolve to its fallback — WCO variables are scoped to the
      // BrowserWindow's own webContents and never reach the child
      // WebContentsView the app renders in (electron/electron#34947).
      expect(source).toMatch(
        /import\s*{[^}]*\bWINDOWS_CAPTION_WIDTH_PX\b[^}]*}\s*from\s*"@shared\/config\/windowChrome"/
      );
      expect(source).toContain("width: `${WINDOWS_CAPTION_WIDTH_PX}px`");
      expect(source).not.toContain("titlebar-area-width");
      expect(source).not.toContain("var(--win-caption-width");
    });

    it("collapses the spacer to zero width when entering fullscreen", () => {
      // Extra classes may ride along (the gap fold); the width must go to 0.
      expect(source).toMatch(/isFullscreen\s*&&\s*"w-0(\s[^"]*)?"/);
    });

    it("places the spacer inside the right toolbar group, after the portal toggle", () => {
      const rightGroupIndex = source.indexOf('aria-label="Tools and settings"');
      const spacerIndex = source.indexOf("width: `${WINDOWS_CAPTION_WIDTH_PX}px`");
      const portalToggleIndex = source.indexOf('buttonRegistry["portal-toggle"]');
      expect(rightGroupIndex).toBeGreaterThan(-1);
      expect(spacerIndex).toBeGreaterThan(-1);
      expect(portalToggleIndex).toBeGreaterThan(-1);
      expect(spacerIndex).toBeGreaterThan(rightGroupIndex);
      expect(spacerIndex).toBeGreaterThan(portalToggleIndex);
    });

    it("uses scoped transition-[width] motion, not transition-all", () => {
      expect(source).toContain("transition-[width]");
      expect(source).not.toContain("transition-all");
    });

    it("uses Tier 3 panel timing (200ms restore / 120ms collapse), not Tier 1", () => {
      expect(source).toMatch(
        /transition-\[width\]\s+duration-200\s+data-\[fullscreen=true\]:duration-120/
      );
      expect(source).not.toContain("duration-150");
    });

    it("drives the asymmetric collapse duration via a data-fullscreen attribute", () => {
      expect(source).toMatch(/data-fullscreen=\{isFullscreen \? "true" : undefined\}/);
    });

    it("applies the Tier 3 timing to both the macOS and Windows spacers", () => {
      const tier3 = /duration-200 data-\[fullscreen=true\]:duration-120/g;
      expect((source.match(tier3) ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it("spacer is decorative (aria-hidden) and not focusable as a toolbar item", () => {
      const spacerBlock = source.slice(
        source.indexOf("isWindows() &&"),
        source.indexOf("width: `${WINDOWS_CAPTION_WIDTH_PX}px`") + 200
      );
      expect(spacerBlock).toContain('aria-hidden="true"');
      expect(spacerBlock).not.toContain("data-toolbar-item");
    });
  });
});

describe("Toolbar keyboard navigation — issue #2814", () => {
  let source: string;

  beforeEach(async () => {
    source = await readToolbarSource();
  });

  describe("Roving tabindex infrastructure", () => {
    it("queries toolbar items via data-toolbar-item selector", () => {
      expect(source).toContain("[data-toolbar-item]:not([disabled])");
    });

    it("keeps the tab stop on the focused item when an item appears ahead of it", () => {
      // The host memory pause indicator (#12375) comes and goes ahead of the
      // assistant and portal toggles. A stored index alone would then point at
      // the newcomer and strand the tab stop away from where focus really is.
      expect(source).toMatch(/items\.findIndex\(\(el\) => el === document\.activeElement\)/);
    });
  });

  describe("Arrow key handler", () => {
    it("wraps around on ArrowRight", () => {
      expect(source).toMatch(/\(currentIdx \+ 1\) % items\.length/);
    });

    it("wraps around on ArrowLeft", () => {
      expect(source).toMatch(/\(currentIdx - 1 \+ items\.length\) % items\.length/);
    });

    it("calls preventDefault only for handled keys", () => {
      // preventDefault should be inside the if (newIdx !== null) block
      expect(source).toMatch(/if\s*\(newIdx !== null\)\s*\{[\s\S]*?e\.preventDefault/);
    });
  });

  describe("Modifier key guard", () => {
    it("returns early when modifier keys are pressed", () => {
      expect(source).toMatch(/if\s*\(e\.metaKey \|\| e\.altKey \|\| e\.ctrlKey\)\s*return/);
    });
  });

  describe("Sub-component integration", () => {
    it("passes data-toolbar-item to AgentButton components", () => {
      // After the dynamic registry refactor (issue #5070), AgentButton is
      // rendered once inside a BUILT_IN_AGENT_IDS.map(...), so a single
      // <AgentButton ... data-toolbar-item="" /> site is expected.
      const agentButtonMatches = source.match(/<AgentButton[\s\S]*?data-toolbar-item=""/g);
      expect(agentButtonMatches).not.toBeNull();
      expect(agentButtonMatches!.length).toBeGreaterThanOrEqual(1);
      // And that single site must be inside a map over the built-in agents
      expect(source).toMatch(
        /BUILT_IN_AGENT_IDS\.map[\s\S]*?<AgentButton[\s\S]*?data-toolbar-item=""/
      );
    });

    it("passes data-toolbar-item to the launcher", () => {
      expect(source).toMatch(/<DockLaunchButton[\s\S]*?data-toolbar-item=""/);
    });

    it("passes data-toolbar-item to VoiceRecordingToolbarButton", () => {
      expect(source).toMatch(/<VoiceRecordingToolbarButton[\s\S]*?data-toolbar-item=""/);
    });

    it("project switcher trigger has data-toolbar-item", () => {
      expect(source).toMatch(/data-toolbar-item=""[\s\S]*?data-testid="project-switcher-trigger"/);
    });
  });
});

describe("Toolbar keyboard navigation — issue #8163", () => {
  let source: string;

  beforeEach(async () => {
    source = await readToolbarSource();
  });

  describe("Portal event guard (Bug 2)", () => {
    it("guards handleToolbarKeyDown against keys originating outside the toolbar DOM subtree", () => {
      // React synthetic events bubble through the React tree, so keydowns
      // inside Radix portal content (DropdownMenuContent, ContextMenuContent
      // — rendered in document.body) still reach this handler. The DOM
      // containment check excludes them so Arrow keys inside an open menu
      // navigate the menu instead of being stolen by toolbar roving focus.
      expect(source).toMatch(
        /if\s*\(!toolbarRef\.current\?\.contains\(e\.target as Node\)\)\s*return/
      );
    });

    it("places the containment guard before the modifier guard", () => {
      const containsIdx = source.search(/toolbarRef\.current\?\.contains\(e\.target as Node\)/);
      const modifierIdx = source.search(/if\s*\(e\.metaKey \|\| e\.altKey \|\| e\.ctrlKey\)/);
      expect(containsIdx).toBeGreaterThan(-1);
      expect(modifierIdx).toBeGreaterThan(-1);
      expect(containsIdx).toBeLessThan(modifierIdx);
    });

    it("places the containment guard before getToolbarItems is called", () => {
      // Bailing before getToolbarItems avoids wasted DOM queries on every
      // portal-originated keydown. Scope to handleToolbarKeyDown's body so
      // the assertion isn't fooled by the earlier getToolbarItems call in
      // handleToolbarFocusCapture.
      const handlerMatch = source.match(
        /handleToolbarKeyDown\s*=\s*useCallback\([\s\S]*?\n\s{2}\);/
      );
      expect(handlerMatch).not.toBeNull();
      const body = handlerMatch![0];
      const containsIdx = body.search(/toolbarRef\.current\?\.contains\(e\.target as Node\)/);
      const itemsIdx = body.search(/const items = getToolbarItems\(\)/);
      expect(containsIdx).toBeGreaterThan(-1);
      expect(itemsIdx).toBeGreaterThan(-1);
      expect(containsIdx).toBeLessThan(itemsIdx);
    });
  });

  describe("Overflow focus redirect (Bug 1)", () => {
    it("updates prevFocusedToolbarItemRef inside the focus-capture handler", () => {
      // The ref must be set inside handleToolbarFocusCapture so the layout
      // effect can detect when that item is later evicted.
      expect(source).toMatch(
        /handleToolbarFocusCapture[\s\S]*?prevFocusedToolbarItemRef\.current\s*=\s*target/
      );
    });

    it("marks the overflow trigger Button with data-toolbar-overflow-trigger", () => {
      // A dedicated marker is required because [data-toolbar-item][aria-haspopup='menu']
      // also matches AgentButton and LauncherMenuButton (which appear earlier in
      // document order), so the overflow trigger cannot be located by that
      // selector alone.
      expect(source).toContain('data-toolbar-overflow-trigger=""');
    });

    it("tags the overflow trigger with its side via data-toolbar-overflow-side", () => {
      // The side marker lets the redirect choose the matching trigger when
      // both groups overflow simultaneously, so focus doesn't jump across
      // the toolbar to the wrong group.
      expect(source).toMatch(/data-toolbar-overflow-side=\{side\}/);
    });

    it("does not locate the overflow trigger via aria-haspopup selector", () => {
      // Regression guard against the AgentButton/LauncherMenuButton false-positive.
      expect(source).not.toMatch(
        /querySelector[^)]*\[data-toolbar-item\]\[aria-haspopup=['"]menu['"]\]/
      );
    });

    it("scopes the overflow trigger lookup by side", () => {
      // Without the [data-toolbar-overflow-side] filter, querySelector
      // returns the first trigger in DOM order (always the left group),
      // misdirecting focus when a right-side item is evicted.
      expect(source).toMatch(
        /\[data-toolbar-overflow-trigger\]\[data-toolbar-overflow-side="\$\{side\}"\]/
      );
    });

    it("chooses the side of the redirect target by group containment", () => {
      // The side selection must come from leftGroupRef/rightGroupRef
      // containment of the previously-focused item, not from a fixed
      // assumption about which side overflowed.
      expect(source).toMatch(/leftGroupRef\.current\?\.contains\(prevFocused\)/);
    });

    it("redirects focus only when the previously-focused item is no longer in items", () => {
      expect(source).toMatch(/!items\.includes\(prevFocused\)/);
    });

    it("guards focus redirect on document.activeElement === document.body", () => {
      // Without this guard the redirect could fire spuriously when focus
      // is intentionally elsewhere (e.g. user clicked an unrelated control
      // between the focus-capture and the next render).
      expect(source).toMatch(/document\.activeElement\s*===\s*document\.body/);
    });

    it("calls .focus() on the redirect target inside the layout effect", () => {
      // The layout-effect block must contain a focus() call gated by the
      // three conditions above.
      expect(source).toMatch(/useLayoutEffect\([\s\S]*?prevFocused[\s\S]*?\.focus\(\)[\s\S]*?\}\)/);
    });

    it("clears prevFocusedToolbarItemRef on eviction, regardless of activeElement", () => {
      // The clear must come BEFORE the activeElement guard so a stale ref
      // is dropped even if the user has moved focus into a Radix portal
      // — otherwise an unrelated later re-render with activeElement === body
      // would trigger a phantom redirect into the toolbar.
      const effectMatch = source.match(/useLayoutEffect\(\(\) => \{[\s\S]*?\n {2}\}\);/);
      expect(effectMatch).not.toBeNull();
      const effectBody = effectMatch![0];
      const clearIdx = effectBody.search(/prevFocusedToolbarItemRef\.current\s*=\s*null/);
      const activeElementIdx = effectBody.search(/document\.activeElement\s*===\s*document\.body/);
      expect(clearIdx).toBeGreaterThan(-1);
      expect(activeElementIdx).toBeGreaterThan(-1);
      expect(clearIdx).toBeLessThan(activeElementIdx);
    });

    it("falls back to items[clamped] when the matching overflow trigger is not present", () => {
      // When neither group renders an overflow menu (everything fits),
      // the redirect should land on the clamped item rather than no-op.
      expect(source).toMatch(/items\[clamped\]/);
    });
  });

  describe("Visible-items filter (load-bearing for redirect)", () => {
    it("excludes items inside aria-hidden wrappers from getToolbarItems", () => {
      // Overflow-hidden buttons use `invisible absolute` Tailwind classes
      // (visibility: hidden), which does NOT null offsetParent. Without an
      // additional aria-hidden ancestor check, evicted items remain in the
      // items list and the overflow focus redirect can never fire.
      expect(source).toMatch(/el\.closest\('\[aria-hidden="true"\]'\)\s*===\s*null/);
    });

    it("keeps the offsetParent guard for display:none cases", () => {
      // Placeholders and other display:none elements must still be filtered
      // out — the aria-hidden check is additive, not a replacement.
      expect(source).toMatch(/el\.offsetParent !== null/);
    });
  });
});

// The strip as a composed whole. Static-source assertions, like the rest of
// the Toolbar.* suite — Toolbar.tsx has too many IPC dependencies to render in
// jsdom — each pinning the rule a rendered-pixel review exposed, not the value
// that happened to satisfy it.
describe("Toolbar strip — composition invariants", () => {
  let source: string;
  let css: string;
  let button: string;

  beforeEach(async () => {
    [source, css, button] = await Promise.all([
      readToolbarSource(),
      Promise.resolve(readToolbarCss()),
      fs.readFile(BUTTON_PATH, "utf-8"),
    ]);
  });

  describe("eviction keeps keyboard focus somewhere real", () => {
    it("redirects while the evicted button is still activeElement, not only once focus has hit body", () => {
      // The browser only drops focus from a newly hidden button at its next
      // rendering update — after the layout effect that notices the eviction.
      // A body-only gate therefore never fired, and focus was lost.
      const effect = source.match(/useLayoutEffect\(\(\) => \{[\s\S]*?\n {2}\}\);/);
      expect(effect).not.toBeNull();
      expect(effect![0]).toMatch(
        /document\.activeElement === document\.body \|\| document\.activeElement === prevFocused/
      );
    });
  });

  describe("the measured rows clip without cropping the focus ring", () => {
    it("both rows use the shared clip class, never a bare overflow-hidden", () => {
      const rows = source.match(/ref=\{(left|right)GroupRef\}\s*className="([^"]+)"/g) ?? [];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toContain("toolbar-measured-row");
        expect(row).not.toContain("overflow-hidden");
      }
    });

    it("the clip margin covers the focus ring's full extent (offset plus width)", () => {
      const rule = css.match(/\.toolbar-measured-row\s*\{([^}]*)\}/);
      expect(rule).not.toBeNull();
      const body = rule![1]!;
      expect(body).toMatch(/overflow:\s*clip/);
      const margin = Number(/overflow-clip-margin:\s*(\d+)px/.exec(body)?.[1]);
      // The ring the rows must not cut: outline width + outline-offset from
      // the toolbar button focus rule.
      const ring = css.match(
        /\.toolbar-icon-button:focus-visible,[\s\S]*?\{[^}]*outline:\s*(\d+)px[^}]*outline-offset:\s*(\d+)px/
      );
      expect(ring).not.toBeNull();
      const extent = Number(ring![1]) + Number(ring![2]);
      expect(margin).toBeGreaterThanOrEqual(extent);
    });
  });

  describe("forced colours", () => {
    it("the project pill carries no at-rest outline suppressor — forced-colors paints its transparent outline as a second ring", () => {
      const pill = source.match(/data-testid="project-switcher-trigger"[\s\S]{0,400}/)?.[0] ?? "";
      const trigger = source.match(
        /<button\s+data-toolbar-item=""\s+className="([^"]+)"[\s\S]{0,200}data-testid="project-switcher-trigger"/
      );
      expect(trigger).not.toBeNull();
      const className = trigger![1]!;
      expect(className).not.toMatch(/(^|\s)outline-hidden(\s|$)/);
      expect(className).toMatch(/focus-visible:outline-/);
      expect(pill).toBeTruthy();
    });

    it("every toolbar badge gets a Canvas outline in place of its stripped ring, so a dot cannot fuse with its glyph", () => {
      const block = css.match(
        /@media \(forced-colors: active\) \{[\s\S]*?\.toolbar-badge,[\s\S]*?\n\}/
      );
      expect(block).not.toBeNull();
      expect(block![0]).toMatch(/\.toolbar-badge,[\s\S]*?outline:\s*\d+(\.\d+)?px solid Canvas/);
    });

    it("group dividers survive forced colours — their background is otherwise reset to Canvas", () => {
      const block = css.match(
        /@media \(forced-colors: active\) \{[\s\S]*?\.toolbar-divider\s*\{([^}]*)\}/
      );
      expect(block).not.toBeNull();
      expect(block![1]).toMatch(/background-color:\s*CanvasText/);
    });
  });

  describe("geometry", () => {
    it("measurement ghosts are the size of the button they stand in for", () => {
      const icon = button.match(/icon:\s*"([^"]+)"/);
      expect(icon).not.toBeNull();
      const size = icon![1]!.match(/\b(h-\d+)\b[^"]*\b(w-\d+)\b/);
      expect(size).not.toBeNull();
      const ghost = source.match(
        /function DevServerPlaceholder\(\)[\s\S]*?className=\{cn\(toolbarIconButtonClass, "([^"]+)"\)\}/
      );
      expect(ghost).not.toBeNull();
      expect(ghost![1]).toContain(size![1]!);
      expect(ghost![1]).toContain(size![2]!);
    });

    it("the grid keeps a gutter between the side groups and the pill", () => {
      const root = source.match(/role="toolbar"[\s\S]*?className=\{cn\(\s*"([^"]+)"/);
      expect(root).not.toBeNull();
      expect(root![1]).toMatch(/\bgap-x-[1-9]\d*\b/);
    });

    it("the strip's content is centred in the surface the eye sees", () => {
      // Unconditional top padding sat every control 2px low for months. The
      // only offset allowed is one pixel for the macOS window-rim highlight,
      // which covers the strip's top row everywhere but fullscreen.
      const root = source.match(
        /role="toolbar"[\s\S]*?className=\{cn\(\s*"([^"]+)",([\s\S]*?)\)\}/
      );
      expect(root).not.toBeNull();
      expect(root![1]).toMatch(/\bh-12\b/);
      expect(root![1]).toMatch(/\bitems-center\b/);
      expect(root![1]).not.toMatch(/\bp[tby]-/);
      expect(root![2]).toMatch(/isMac\(\) && !isFullscreen && "pt-px"/);
    });

    it("dividers never shrink to nothing under width pressure", () => {
      const classes = source.match(/const toolbar(?:Fixed)?DividerClass = "([^"]+)"/g) ?? [];
      expect(classes.length).toBeGreaterThanOrEqual(2);
      for (const c of classes) expect(c).toContain("shrink-0");
    });

    it("every divider gets the same clearance as its neighbours' gap", () => {
      // Inside a measured row: gap-0.5 + mx-1 on each side. In the outer
      // groups: gap-1.5 alone. Both come to the same 6px, so the fixed
      // dividers carry no margin of their own.
      const fixed = source.match(/const toolbarFixedDividerClass = "([^"]+)"/);
      expect(fixed).not.toBeNull();
      expect(fixed![1]).not.toMatch(/\bm[xlr]-\d/);
      const inner = source.match(/const toolbarDividerClass = "([^"]+)"/);
      expect(inner).not.toBeNull();
      expect(inner![1]).toMatch(/\bmx-1\b/);
      // And the two outer-group dividers use the fixed class.
      expect(source.match(/className=\{toolbarFixedDividerClass\}/g)).toHaveLength(2);
    });

    it("an empty overflow trigger leaves no wrapper behind to own a gap", () => {
      // The trigger is display:none when nothing is hidden; a wrapper around
      // it would still be a zero-width flex item costing gap-1.5.
      expect(source).not.toMatch(/<div className="app-no-drag">\s*\{renderOverflowMenu\(/);
      expect(source).toMatch(
        /data-toolbar-overflow-trigger=""[\s\S]{0,600}?className=\{cn\(toolbarIconButtonClass, "app-no-drag[^"]*"/
      );
    });

    it("a collapsed platform spacer folds its flex gap away too", () => {
      // Both spacers: a w-0 item still owns a gap on each side of it.
      const collapsed =
        source.match(/isFullscreen \? "w-0[^"]*"|isFullscreen && "w-0[^"]*"/g) ?? [];
      expect(collapsed).toHaveLength(2);
      for (const c of collapsed) expect(c).toMatch(/-m[lr]-/);
    });
  });

  describe("both sides share one rulebook", () => {
    it("the right side is grouped and divided exactly like the left", () => {
      expect(source).toContain("renderGroupedButtons(effectiveLeftButtons");
      expect(source).toContain("renderGroupedButtons(effectiveRightButtons");
      const left =
        source.match(/const positionedLeftButtons = useMemo\([\s\S]*?\n {2}\}, \[/)?.[0] ?? "";
      const right =
        source.match(/const positionedRightButtons = useMemo\([\s\S]*?\n {2}\}, \[/)?.[0] ?? "";
      expect(left).toContain("orderToolbarButtonsByGroup(");
      expect(right).toContain("orderToolbarButtonsByGroup(");
    });

    it("the overflow engine is told what a group boundary costs", () => {
      // The same divider runs the render draws (panels and utilities share one).
      expect(source).toMatch(/useToolbarOverflow\([\s\S]*?pinnedIds,\s*resolveDividerRun,/);
      expect(source).toMatch(/getToolbarDividerAfterIds\([\s\S]*?resolveDividerRun\s*\)/);
    });
  });
});
