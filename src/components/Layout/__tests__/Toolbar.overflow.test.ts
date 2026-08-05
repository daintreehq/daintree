import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { extractAtRuleBlocks } from "./cssBlocks";

const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");
const TOOLBAR_CSS_PATH = path.resolve(__dirname, "../../../styles/components/toolbar.css");

// Issue #9821 — the `…` overflow menu dropped every contextual signal the
// evicted toolbar buttons carry (error/unread counts, agent-state dots,
// keyboard shortcuts, the GitHub group label), gave no feedback when copy-tree
// fired from overflow, and the trigger popped in/out without an animation.
// These are static-source assertions (the rest of the Toolbar.* suite uses the
// same approach — Toolbar.tsx has too many IPC dependencies to render in jsdom).
describe("Toolbar overflow menu state preservation — issue #9821", () => {
  let source: string;
  let css: string;

  beforeEach(async () => {
    [source, css] = await Promise.all([
      fs.readFile(TOOLBAR_PATH, "utf-8"),
      fs.readFile(TOOLBAR_CSS_PATH, "utf-8"),
    ]);
  });

  describe("imports", () => {
    it("pulls in the dropdown primitives needed for shortcuts, labels, and groups", () => {
      expect(source).toContain("DropdownMenuShortcut");
      expect(source).toContain("DropdownMenuLabel");
      expect(source).toContain("DropdownMenuGroup");
    });

    it("imports the agent-state dot helpers and notify", () => {
      expect(source).toContain("agentStateDotColor");
      expect(source).toContain("deriveAgentDominantStates");
      expect(source).toContain('import { notify } from "@/lib/notify"');
    });
  });

  describe("per-item counts", () => {
    it("reads the live notification unread count for the menu item", () => {
      expect(source).toContain("useNotificationHistoryStore((s) => s.unreadCount)");
    });

    it("appends the error count to the problems item and unread count to notifications", () => {
      // countSuffix derives both from the same primitives the source buttons use.
      expect(source).toMatch(/id === "problems" && errorCount > 0/);
      expect(source).toMatch(/id === "notification-center" && notificationUnreadCount > 0/);
    });
  });

  describe("agent-state dots", () => {
    it("derives a per-agent dominant state map scoped to the active worktree", () => {
      expect(source).toContain("agentDominantStates");
      // Shared with AgentTrayButton so the overflow dot matches the visible
      // agent button; computed inside useShallow so agent ticks that don't
      // change a dominant state don't re-render the toolbar.
      expect(source).toMatch(
        /useShallow\(\(s\) => deriveAgentDominantStates\(s\.panelsById, s\.panelIds, activeWorktreeId\)\)/
      );
    });

    it("renders the dot through a dedicated component so the keybinding hook is at component scope", () => {
      // A hook inside a .map() callback would violate the rules of hooks; the
      // AgentOverflowItem component is the fix (mirrors AgentTrayButton).
      expect(source).toContain("function AgentOverflowItem");
      expect(source).toContain("useKeybindingDisplay(`agent.${id}`)");
      expect(source).toContain("agentStateDotColor(dominantState)");
    });
  });

  describe("keyboard shortcut hints", () => {
    it("looks up shortcuts for the fixed-action overflow items", () => {
      expect(source).toContain('useKeybindingDisplay("notifications.toggle")');
      expect(source).toContain('useKeybindingDisplay("action.palette.open")');
    });

    it("maps each fixed-action item id to its shortcut", () => {
      expect(source).toMatch(/"copy-tree":\s*copyTreeShortcut/);
      expect(source).toMatch(/"notification-center":\s*notificationsShortcut/);
      expect(source).toMatch(/"command-palette":\s*commandPaletteShortcut/);
      expect(source).toMatch(/"dev-server":\s*devServerShortcut/);
    });

    it("covers the remaining shortcut-bearing buttons — settings, problems, terminal, browser", () => {
      // These all show a shortcut hint on their visible toolbar button, so the
      // overflow item must too (issue #9821).
      expect(source).toContain('useKeybindingDisplay("app.settings")');
      expect(source).toContain('useKeybindingDisplay("panel.toggleDiagnostics")');
      expect(source).toContain('useKeybindingDisplay("agent.terminal")');
      expect(source).toContain('useKeybindingDisplay("agent.browser")');
      expect(source).toMatch(/settings:\s*settingsShortcut/);
      expect(source).toMatch(/problems:\s*problemsShortcut/);
      expect(source).toMatch(/terminal:\s*terminalShortcut/);
      expect(source).toMatch(/browser:\s*browserShortcut/);
    });

    it("wires the file browser's shortcut hint like the other launchers (#11495)", () => {
      expect(source).toContain('useKeybindingDisplay("worktree.openFileBrowserPanel")');
      expect(source).toMatch(/"file-browser":\s*fileBrowserShortcut/);
    });
  });

  describe("file browser overflow item — issue #11495", () => {
    it("reuses the visible button's handler rather than re-dispatching inline", () => {
      // One handler for the button, the overflow item, and the Retry action, so
      // the refusal path can't drift between them.
      expect(source).toMatch(/"file-browser":\s*openFileBrowser,/);
    });

    it("surfaces the refusal instead of pressing silently", () => {
      // The action resolves its own target and throws when a workspace has
      // nothing to browse; dispatch converts that to ok:false, so without this
      // branch the press would do nothing at all.
      expect(source).toMatch(/if \(result\.ok\) return;/);
      expect(source).toContain("Couldn't open the file browser");
      expect(source).toMatch(/label: "Retry", onClick: openFileBrowser/);
    });

    it("leaves the already-reported full-grid refusal alone (#11666)", () => {
      // Now that the button opens a real panel it can also be refused for a
      // full grid — which `addPanel` has already reported accurately. The
      // workspace-shaped message must not fire on top of it.
      expect(source).toMatch(/if \(isPanelLimitError\(result\.error\.message\)\) return;/);
    });
  });

  describe("review fixes", () => {
    it("resets controlled open state when the menu empties so it doesn't self-reopen", () => {
      // Without this, widening then re-narrowing the window pops the overflow
      // menu open with no user action.
      expect(source).toMatch(
        /useEffect\(\(\)\s*=>\s*\{\s*if \(isEmpty\) setOpen\(false\);?\s*\}, \[isEmpty\]\)/
      );
    });

    it("disables the overflow copy-tree item when there is no active worktree", () => {
      // Mirrors the visible button's aria-disabled "Open a worktree first" state.
      expect(source).toMatch(/id === "copy-tree" && !hasActiveWorktree/);
      expect(source).toContain("disabled={disabled}");
    });
  });

  describe("forge-stats group label", () => {
    it("wraps the three forge items in a group labelled with the provider name", () => {
      // DropdownMenuLabel alone is insufficient — the Group wires role=group +
      // aria-labelledby so the boundary is announced.
      expect(source).toMatch(
        /<DropdownMenuGroup[\s\S]*?<DropdownMenuLabel>\{forgeProviderName\}<\/DropdownMenuLabel>/
      );
    });
  });

  describe("copy-tree feedback from overflow", () => {
    it("fires a transient success toast on the overflow path", () => {
      expect(source).toContain("handleCopyTreeOverflow");
      expect(source).toMatch(/notify\(\{[\s\S]*?transient: true[\s\S]*?\}\)/);
    });

    it("wires the overflow action to the toast handler, not the inline-feedback handler", () => {
      expect(source).toMatch(/"copy-tree":\s*\(\)\s*=>\s*\{\s*void handleCopyTreeOverflow\(\)/);
    });

    it("keeps the eslint exception for an action-free notify", () => {
      expect(source).toContain("notify-no-action: ok");
    });
  });

  describe("trigger entry/exit animation", () => {
    it("keeps the trigger mounted and toggles data-visible instead of returning null", () => {
      expect(source).toContain('data-visible={isEmpty ? "false" : "true"}');
      // The empty trigger must drop out of roving focus and not be clickable.
      expect(source).toContain("aria-hidden={isEmpty || undefined}");
      expect(source).toContain("tabIndex={isEmpty ? -1 : undefined}");
    });

    it("forces the menu closed when empty while staying controlled (no React warning)", () => {
      expect(source).toMatch(/open=\{isEmpty \? false : open\}/);
    });

    it("animates the trigger via @starting-style + allow-discrete, opacity-only", () => {
      expect(css).toMatch(
        /\[data-toolbar-overflow-trigger\]\s*\{[\s\S]*?display:\s*none;[\s\S]*?allow-discrete/
      );
      expect(css).toMatch(
        /\[data-toolbar-overflow-trigger\]\[data-visible="true"\][\s\S]*?@starting-style/
      );
      // Opacity-only — no scale transform like the pip badge uses.
      const triggerBlock = css.match(
        /\[data-toolbar-overflow-trigger\]\[data-visible="true"\]\s*\{[\s\S]*?\}/
      )?.[0];
      expect(triggerBlock).toBeDefined();
      expect(triggerBlock).not.toContain("scale");
    });

    it("keeps a timed (not none) display swap under reduced motion — lesson #6182", () => {
      // Inside the @variant reduce-motion block the trigger must still toggle
      // display (display 0s, not transition: none) so the discrete swap lands.
      // Brace-walk the blocks rather than regexing across them: toolbar.css now
      // has more than one reduce-motion block, and a lazy `[\s\S]*?` match would
      // happily start in an earlier one and run out of it, proving nothing.
      const trigger = extractAtRuleBlocks(css, "@variant reduce-motion").find((block) =>
        block.includes("[data-toolbar-overflow-trigger]")
      );
      expect(trigger, "no reduce-motion block styles the overflow trigger").toBeDefined();
      expect(trigger).toMatch(/\[data-toolbar-overflow-trigger\]\s*\{[^{}]*display\s+0s/);
    });
  });
});
