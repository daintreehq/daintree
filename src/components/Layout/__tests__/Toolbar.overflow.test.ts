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
    it("pulls in the dropdown primitives needed for labels and groups", () => {
      expect(source).toContain("DropdownMenuLabel");
      expect(source).toContain("DropdownMenuGroup");
    });

    it("imports the agent-state dot helpers and notify", () => {
      expect(source).toContain("agentStateDotColor");
      expect(source).toContain("deriveAgentAttentionStates");
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
    it("derives a per-agent pip state map scoped to the active worktree", () => {
      expect(source).toContain("agentAttentionStates");
      // Shared with the launcher so the overflow dot matches the visible
      // agent button; computed inside useShallow so agent ticks that don't
      // change a pip state don't re-render the toolbar.
      expect(source).toMatch(
        /useShallow\(\(s\) => deriveAgentAttentionStates\(s\.panelsById, s\.panelIds, activeWorktreeId\)\)/
      );
    });

    it("renders the dot through a dedicated component that shows the agent's own binding", () => {
      expect(source).toContain("function AgentOverflowItem");
      expect(source).toContain("keybinding={`agent.${id}`}");
      expect(source).toContain("agentStateDotColor(attentionState)");
      // The pip is aria-hidden, so the row's accessible name carries its state.
      expect(source).toMatch(/sr-only[^\n]*STATE_LABELS\[attentionState\]/);
    });
  });

  describe("keyboard shortcut hints", () => {
    // The menu primitive draws each item's live binding from the action id it is
    // handed, so what must hold here is the id → action mapping and its use.
    const EXPECTED: Record<string, string> = {
      "copy-tree": "worktree.copyTree",
      "notification-center": "notifications.toggle",
      "command-palette": "action.palette.open",
      "dev-server": "devServer.start",
      // These all show a shortcut hint on their visible toolbar button, so the
      // overflow item must too (issue #9821).
      settings: "app.settings",
      problems: "panel.toggleDiagnostics",
      terminal: "agent.terminal",
      browser: "agent.browser",
      // #11495
      "file-browser": "worktree.openFileBrowserPanel",
    };

    it("maps each shortcut-bearing item id to the action whose binding it shows", () => {
      const block = /const OVERFLOW_KEYBINDING_BY_ID[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
      expect(block, "OVERFLOW_KEYBINDING_BY_ID not found").not.toBeNull();
      for (const [id, actionId] of Object.entries(EXPECTED)) {
        const key = /^[a-z]+$/.test(id) ? id : `"${id}"`;
        expect(block![1]).toMatch(
          new RegExp(`${key.replace(/[-]/g, "\\-")}:\\s*"${actionId.replace(/\./g, "\\.")}"`)
        );
      }
    });

    it("hands every overflow row its binding through the menu primitive", () => {
      expect(source).toContain("keybindingById={OVERFLOW_KEYBINDING_BY_ID}");
      expect(source).toMatch(/keybinding=\{keybindingById\[item\.id\]\}/);
      expect(source).toMatch(/keybinding=\{keybindingById\[id\]\}/);
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

    it("disables the overflow copy-tree item exactly when its handler would refuse", () => {
      // Mirrors the visible button's aria-disabled states: no active worktree
      // ("Open a worktree first") and a copy already in flight — which can
      // start from routes that never touch this menu (MCP, Cmd+Shift+C), so
      // the item must not look live while activation would silently no-op.
      expect(source).toMatch(/id === "copy-tree" && \(!hasActiveWorktree \|\| isCopyingTree\)/);
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

  describe("copy-tree feedback from overflow — #9821, superseded by #11735", () => {
    it("keeps the overflow item on the immediate-copy handler the panel also calls", () => {
      // #9821 gave overflow its own handler because the visible button's only
      // feedback was an inline check the overflow menu couldn't show. Once
      // completion became a toast from the `worktree.copyTree` action, both
      // routes collapsed onto one handler — and #11733 kept it that way rather
      // than nesting a panel inside the overflow menu. So the overflow row and
      // the panel's own "Copy full context" row must reach the SAME handler;
      // a second one could only drift from the first.
      expect(source).toMatch(/"copy-tree":\s*\(\)\s*=>\s*\{\s*void handleCopyTreeClick\(\)/);
      expect(source).not.toContain("handleCopyTreeOverflow");
      expect(source).toMatch(
        /const handleCopyTreeFullContext = useCallback\(\(\) => \{[\s\S]*?void handleCopyTreeClick\(\)/
      );
    });

    it("routes the visible button to the menu, not to the immediate copy (#11733)", () => {
      // The half of the split that is easy to regress: re-pointing the trigger
      // back at the immediate handler would restore one-click copying and
      // silently strand the menu. Asserted on the block rather than the file
      // because the immediate handler still legitimately appears elsewhere.
      const copyTreeBlock = source.match(/"copy-tree":\s*\{[\s\S]*?isAvailable/);
      expect(copyTreeBlock).not.toBeNull();
      // The button is the menu's trigger, and the menu's open state is what
      // the toolbar controls — not a click handler on the button.
      expect(copyTreeBlock![0]).toContain("<DropdownMenuTrigger asChild>");
      expect(copyTreeBlock![0]).toContain("onOpenChange={handleCopyTreeOpenChange}");
      expect(copyTreeBlock![0]).not.toContain("onClick={handleCopyTreeClick}");
    });

    it("no longer raises its own copy-tree toast in the toolbar", () => {
      // The toolbar must not re-announce what the action already announces;
      // two toasts per press was the failure mode this consolidation prevents.
      expect(source).not.toMatch(/notify\(\{[\s\S]{0,200}?title: "Context copied"/);
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

    it("keeps its timed display swap under reduced motion, so the fade-out paints — lesson #6182", () => {
      // The trigger only fades, so reduced motion has nothing to remove. A
      // reduce-motion override that zeroed the display swap (`display 0s`)
      // dropped it to display:none before its opacity exit could paint.
      // Brace-walk the blocks rather than regexing across them.
      for (const block of extractAtRuleBlocks(css, "@variant reduce-motion")) {
        const rule = block.match(/\[data-toolbar-overflow-trigger\][^{]*\{[^{}]*\}/)?.[0] ?? "";
        expect(rule).not.toMatch(/display\s+0s|transition:\s*none/);
      }
      expect(css).toMatch(
        /\[data-toolbar-overflow-trigger\]\s*\{[^{}]*display\s+var\(--duration-\d+\)\s+allow-discrete/
      );
    });
  });
});
