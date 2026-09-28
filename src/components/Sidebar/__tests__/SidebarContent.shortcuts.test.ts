import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");

describe("SidebarContent shortcut labels — issue #5843", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  describe("live binding hooks", () => {
    it("uses dynamic hook for worktree.overview", () => {
      expect(source).toContain('useEffectiveCombo("worktree.overview")');
    });

    it("does NOT consume fleet.armFocused for the Zap button (binding mismatch)", () => {
      // The Zap button used to read `useKeybindingDisplay("fleet.armFocused")`
      // and pass it to the tooltip. That shortcut binds the *toggle armed
      // pane* action (Cmd+J), not "open the picker". After Phase 3 the Zap
      // button opens FleetPickerPalette and the tooltip advertises no
      // shortcut. Enforce that the stale hook call doesn't creep back.
      expect(source).not.toMatch(/use(KeybindingDisplay|EffectiveCombo)\("fleet\.armFocused"\)/);
    });

    it("uses dynamic hook for worktree.refresh", () => {
      expect(source).toContain('useEffectiveCombo("worktree.refresh")');
    });

    it("uses dynamic hook for worktree.createDialog.open", () => {
      expect(source).toContain('useEffectiveCombo("worktree.createDialog.open")');
    });
  });

  describe("no hardcoded shortcut strings in button titles", () => {
    it("does not hardcode shortcut strings in formatButtonTitle calls", () => {
      expect(source).not.toMatch(/formatButtonTitle\([^)]*"Cmd\+/);
      expect(source).not.toMatch(/formatButtonTitle\([^)]*"Ctrl\+/);
    });

    it("does not assign hardcoded shortcut literals to *Shortcut variables", () => {
      expect(source).not.toMatch(/const\s+\w*Shortcut\s*=\s*["'](Cmd|Ctrl|Shift|Alt|Option)/);
    });
  });

  describe("aria-keyshortcuts exposure (issue #6874)", () => {
    it("calls useAriaKeyshortcuts for each shortcut-bearing button", () => {
      expect(source).toContain('useAriaKeyshortcuts("worktree.overview")');
      expect(source).toContain('useAriaKeyshortcuts("worktree.refresh")');
      expect(source).toContain('useAriaKeyshortcuts("worktree.createDialog.open")');
    });

    it("renders aria-keyshortcuts on each interactive button", () => {
      expect(source).toContain("aria-keyshortcuts={overviewAriaShortcut}");
      expect(source).toContain("aria-keyshortcuts={refreshAriaShortcut}");
      expect(source).toContain("aria-keyshortcuts={createWorktreeAriaShortcut}");
    });
  });

  describe("header tooltips", () => {
    /**
     * The contiguous `<Tooltip>` block around the control carrying `marker`,
     * with no nested `<Tooltip>` opening in between — so what the block says is
     * proven to belong to THIS button rather than to a sibling in the header.
     */
    function tooltipFor(marker: string): string {
      const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const block = source.match(
        new RegExp(`<Tooltip>(?:(?!<Tooltip>)[\\s\\S])*?${escaped}[\\s\\S]*?</Tooltip>`)
      );
      expect(block, `no Tooltip wraps the control carrying ${marker}`).not.toBeNull();
      return block![0];
    }

    function buttonTag(block: string): string {
      return block.match(/<(?:button|Button)\b[\s\S]*?>/)![0];
    }

    it("labels every header action through the app Tooltip, never a native title", () => {
      // A native title shows late, unstyled and never on keyboard focus, and
      // beside a Tooltip it doubles up (#11633). The four header actions all
      // take the shared Tooltip.
      for (const marker of [
        "onClick={onOpenOverview}",
        "onClick={openFleetPicker}",
        "onClick={handleRefreshAll}",
        'aria-label="Create new worktree"',
      ]) {
        expect(buttonTag(tooltipFor(marker))).not.toMatch(/\btitle=/);
      }
    });

    it("carries each action's live shortcut as a chord pill, not a string suffix", () => {
      expect(tooltipFor("onClick={onOpenOverview}")).toMatch(
        /createTooltipContent\("Open worktrees overview", overviewShortcut\)/
      );
      expect(tooltipFor("onClick={handleRefreshAll}")).toMatch(
        /createTooltipContent\("Refresh sidebar", refreshShortcut\)/
      );
      expect(tooltipFor('aria-label="Create new worktree"')).toMatch(
        /createTooltipContent\("Create new worktree", createWorktreeShortcut\)/
      );
    });

    it("advertises no shortcut for Select terminals to arm (no binding opens the picker)", () => {
      // The Zap button opens the FleetPickerPalette, which has no keybinding.
      // Earlier it rendered `armFocusedShortcut` (Cmd+J), which is the *toggle
      // armed pane* binding, not "open the picker", and so misled users.
      const block = tooltipFor("onClick={openFleetPicker}");
      expect(block).toMatch(
        /<TooltipContent side="bottom">Select terminals to arm<\/TooltipContent>/
      );
      expect(block).not.toMatch(/createTooltipContent/);
    });
  });
});
