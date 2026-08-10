import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");
const PROBLEMS_BUTTON_PATH = path.resolve(__dirname, "../ToolbarProblemsButton.tsx");
const PORTAL_BUTTON_PATH = path.resolve(__dirname, "../ToolbarPortalButton.tsx");
const SETTINGS_BUTTON_PATH = path.resolve(__dirname, "../ToolbarSettingsButton.tsx");
const LAUNCHER_BUTTON_PATH = path.resolve(__dirname, "../ToolbarLauncherButton.tsx");
const AGENT_BUTTON_PATH = path.resolve(__dirname, "../AgentButton.tsx");
const VOICE_RECORDING_PATH = path.resolve(__dirname, "../VoiceRecordingToolbarButton.tsx");
const PLUGIN_TRAY_PATH = path.resolve(__dirname, "../PluginTrayButton.tsx");
const COPY_TREE_ACTION_PATH = path.resolve(
  __dirname,
  "../../../services/actions/definitions/worktreeContextActions.ts"
);
const TOOLBAR_CSS_PATH = path.resolve(__dirname, "../../../styles/components/toolbar.css");

describe("Toolbar shortcut tooltips — issue #3443", () => {
  let source: string;
  let problemsSource: string;
  let portalSource: string;
  let settingsSource: string;
  let launcherSource: string;
  let agentSource: string;
  let voiceSource: string;
  let pluginTraySource: string;

  beforeEach(async () => {
    [
      source,
      problemsSource,
      portalSource,
      settingsSource,
      launcherSource,
      agentSource,
      voiceSource,
      pluginTraySource,
    ] = await Promise.all([
      fs.readFile(TOOLBAR_PATH, "utf-8"),
      fs.readFile(PROBLEMS_BUTTON_PATH, "utf-8"),
      fs.readFile(PORTAL_BUTTON_PATH, "utf-8"),
      fs.readFile(SETTINGS_BUTTON_PATH, "utf-8"),
      fs.readFile(LAUNCHER_BUTTON_PATH, "utf-8"),
      fs.readFile(AGENT_BUTTON_PATH, "utf-8"),
      fs.readFile(VOICE_RECORDING_PATH, "utf-8"),
      fs.readFile(PLUGIN_TRAY_PATH, "utf-8"),
    ]);
  });

  describe("useKeybindingDisplay hooks", () => {
    it("uses dynamic hook for nav.toggleSidebar", () => {
      expect(source).toContain('useKeybindingDisplay("nav.toggleSidebar")');
    });

    it("uses dynamic hook for panel.toggleDiagnostics", () => {
      expect(problemsSource).toContain('useKeybindingDisplay("panel.toggleDiagnostics")');
    });

    it("uses dynamic hook for panel.togglePortal", () => {
      expect(portalSource).toContain('useKeybindingDisplay("panel.togglePortal")');
    });

    it("uses dynamic hook for worktree.copyTree", () => {
      expect(source).toContain('useKeybindingDisplay("worktree.copyTree")');
    });

    it("uses dynamic hook for app.settings", () => {
      expect(settingsSource).toContain('useKeybindingDisplay("app.settings")');
    });

    it("uses dynamic hook for devServer.start", () => {
      expect(source).toContain('useKeybindingDisplay("devServer.start")');
    });

    it("uses dynamic hook for worktree.openFileBrowserPanel", () => {
      expect(source).toContain('useKeybindingDisplay("worktree.openFileBrowserPanel")');
    });
  });

  describe("file browser button accessibility — issue #11495", () => {
    it("announces its shortcut and shows the hover hint like its siblings", () => {
      // The three-hook set every shortcut-bearing toolbar button carries: the
      // tooltip display string, the aria-keyshortcuts value for screen readers,
      // and the press-and-hold hover hint.
      expect(source).toContain('useAriaKeyshortcuts("worktree.openFileBrowserPanel")');
      expect(source).toContain('useShortcutHintHover("worktree.openFileBrowserPanel")');
      expect(source).toContain("aria-keyshortcuts={fileBrowserAriaShortcut}");
      // Spread conditionally since #11499: with no workspace the action can
      // resolve no folder, so the button degrades to aria-disabled and the
      // press-and-hold hint would advertise a shortcut that only errors.
      expect(source).toContain("hasWorkspace ? fileBrowserHintHover : {}");
    });

    it("uses createTooltipContent for the file browser tooltip", () => {
      expect(source).toContain('createTooltipContent("Browse files", fileBrowserShortcut)');
    });
  });

  describe("no hardcoded shortcut strings in tooltips", () => {
    it("does not hardcode Cmd+B as a tooltip argument", () => {
      expect(source).not.toMatch(/createTooltipContent\([^)]*"Cmd\+B"/);
    });

    it("does not hardcode Ctrl+Shift+M as a tooltip argument", () => {
      expect(source).not.toMatch(/createTooltipContent\([^)]*"Ctrl\+Shift\+M"/);
    });
  });

  describe("no manual ternary tooltip patterns", () => {
    it("does not use manual ternary for terminal shortcut", () => {
      expect(source).not.toContain("terminalShortcut ?");
      expect(launcherSource).not.toContain("terminalShortcut ?");
    });

    it("does not use manual ternary for browser shortcut", () => {
      expect(source).not.toContain("browserShortcut ?");
      expect(launcherSource).not.toContain("browserShortcut ?");
    });
  });

  describe("createTooltipContent usage", () => {
    it("uses createTooltipContent for terminal tooltip", () => {
      expect(launcherSource).toContain('tooltipLabel: "Open terminal"');
      expect(launcherSource).toContain("createTooltipContent(config.tooltipLabel, shortcut)");
    });

    it("uses createTooltipContent for browser tooltip", () => {
      expect(launcherSource).toContain('tooltipLabel: "Open browser"');
      expect(launcherSource).toContain("createTooltipContent(config.tooltipLabel, shortcut)");
    });

    it("uses createTooltipContent for settings tooltip", () => {
      expect(settingsSource).toContain('createTooltipContent("Open settings", settingsShortcut)');
    });

    it("uses createTooltipContent for problems tooltip with dynamic shortcut", () => {
      expect(problemsSource).toContain(
        'createTooltipContent("Show problems panel", diagnosticsShortcut)'
      );
    });

    it("uses createTooltipContent for portal tooltip", () => {
      expect(portalSource).toContain("createTooltipContent");
      expect(portalSource).toContain("portalShortcut");
    });

    it("uses createTooltipContent for copy-tree tooltip", () => {
      expect(source).toContain('createTooltipContent("Copy context", copyTreeShortcut)');
    });

    it("uses createTooltipContent for dev-server tooltip", () => {
      expect(source).toContain('createTooltipContent("Open dev preview", devServerShortcut)');
    });

    it("uses createTooltipContent for sidebar tooltip with dynamic shortcut", () => {
      const sidebarBlock = source.match(/"sidebar-toggle":\s*\{[\s\S]*?isAvailable/);
      expect(sidebarBlock).not.toBeNull();
      expect(sidebarBlock![0]).toContain("createTooltipContent");
      expect(sidebarBlock![0]).toContain("sidebarShortcut");
    });

    it("uses createTooltipContent for AgentButton primary tooltip", () => {
      expect(agentSource).toContain("createTooltipContent(tooltipLabel, tooltipShortcut)");
      expect(agentSource).toContain("const tooltipLabel");
      expect(agentSource).toContain("const tooltipShortcut");
    });
  });

  describe("aria-keyshortcuts exposure (issue #6874)", () => {
    it("Toolbar.tsx calls useAriaKeyshortcuts for each direct toolbar button", () => {
      expect(source).toContain('useAriaKeyshortcuts("nav.toggleSidebar")');
      expect(source).toContain('useAriaKeyshortcuts("worktree.copyTree")');
    });

    it("Toolbar.tsx renders aria-keyshortcuts on its direct buttons", () => {
      expect(source).toContain("aria-keyshortcuts={sidebarAriaShortcut}");
      expect(source).toContain("aria-keyshortcuts={copyTreeAriaShortcut}");
    });

    it("ToolbarProblemsButton renders aria-keyshortcuts", () => {
      expect(problemsSource).toContain('useAriaKeyshortcuts("panel.toggleDiagnostics")');
      expect(problemsSource).toContain("aria-keyshortcuts={diagnosticsAriaShortcut}");
    });

    it("ToolbarPortalButton renders aria-keyshortcuts", () => {
      expect(portalSource).toContain('useAriaKeyshortcuts("panel.togglePortal")');
      expect(portalSource).toContain("aria-keyshortcuts={portalAriaShortcut}");
    });

    it("ToolbarSettingsButton renders aria-keyshortcuts", () => {
      expect(settingsSource).toContain('useAriaKeyshortcuts("app.settings")');
      expect(settingsSource).toContain("aria-keyshortcuts={settingsAriaShortcut}");
    });

    it("ToolbarLauncherButton renders aria-keyshortcuts", () => {
      expect(launcherSource).toContain("useAriaKeyshortcuts(config.keybindingAction)");
      expect(launcherSource).toContain("aria-keyshortcuts={ariaShortcut}");
    });

    it("AgentButton renders aria-keyshortcuts on both primary Buttons", () => {
      expect(agentSource).toContain("useAriaKeyshortcuts(`agent.${type}`)");
      const matches = agentSource.match(/aria-keyshortcuts=\{ariaShortcut\}/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("copy-tree button polish — issue #8179", () => {
    it("imports useDohertyGate from @/hooks", () => {
      expect(source).toMatch(/useDohertyGate[\s\S]*?from "@\/hooks"/);
    });

    it("derives showCopyingSpinner via useDohertyGate at the Doherty threshold", () => {
      expect(source).toContain("const showCopyingSpinner = useDohertyGate(isCopyingTree);");
    });

    it("gates the spinner glyph on showCopyingSpinner, not raw isCopyingTree", () => {
      const copyTreeBlock = source.match(/"copy-tree":\s*\{[\s\S]*?isAvailable/);
      expect(copyTreeBlock).not.toBeNull();
      // The Doherty gate is the point: the raw in-flight flag must never drive
      // the glyph directly, or a sub-400ms copy flashes a spinner.
      expect(copyTreeBlock![0]).toMatch(/showCopyingSpinner \?\s*<Spinner \/>/);
      expect(copyTreeBlock![0]).not.toMatch(/isCopyingTree \?\s*<Spinner \/>/);
      expect(copyTreeBlock![0]).toContain("<Folders />");
    });

    it("carries no inline completion feedback — the toast owns it (issue #11735)", () => {
      // The button used to swap in a check icon and force its tooltip open for
      // two seconds. That feedback was invisible from the overflow menu and had
      // no counterpart on any other copy-tree route, so it moved to the
      // `worktree.copyTree` completion toast. Only the in-flight spinner stays.
      const copyTreeBlock = source.match(/"copy-tree":\s*\{[\s\S]*?isAvailable/);
      expect(copyTreeBlock).not.toBeNull();
      expect(copyTreeBlock![0]).not.toContain("treeCopied");
      expect(copyTreeBlock![0]).not.toContain("<Check />");
      expect(copyTreeBlock![0]).not.toContain("text-status-success");
      // A controlled `open` prop is what forced the tooltip; the plain <Tooltip>
      // must stay uncontrolled.
      expect(copyTreeBlock![0]).not.toMatch(/<Tooltip\s+open=/);
      expect(copyTreeBlock![0]).not.toContain('role="status"');
    });

    it("skips the hover hint, matching the action's suppressShortcutHint opt-out", async () => {
      // Relational, across two files: `suppressShortcutHint` only blocks the
      // hint ActionService emits after dispatch, and its own contract says an
      // opted-out button must skip `useShortcutHintHover` too — the hover path
      // teaches the same hint and a shown one survives the click, landing
      // beside the completion toast in the same corner. Reading the action
      // definition here is what makes this an agreement check rather than a
      // restatement of either side.
      const definitionSource = await fs.readFile(COPY_TREE_ACTION_PATH, "utf-8");
      const copyTreeAction = definitionSource.match(/id: "worktree\.copyTree"[\s\S]*?run: async/);
      expect(copyTreeAction).not.toBeNull();
      if (!copyTreeAction![0].includes("suppressShortcutHint: true")) return;

      const copyTreeBlock = source.match(/"copy-tree":\s*\{[\s\S]*?isAvailable/);
      expect(copyTreeBlock).not.toBeNull();
      expect(copyTreeBlock![0]).not.toMatch(/\{\.\.\.\w*[Hh]intHover\}/);
    });

    it("retires the inline-feedback state and its reset timer entirely", () => {
      // Component-wide, not block-scoped: leftover state or a dangling timeout
      // would keep the removed behavior alive outside the render block.
      for (const symbol of [
        "treeCopied",
        "copyFeedback",
        "treeCopyTimeoutRef",
        "COPY_TREE_FEEDBACK_RESET_MS",
      ]) {
        expect(source).not.toContain(symbol);
      }
    });
  });

  describe("copy-tree recents dropdown — issue #11733", () => {
    // Only invariants that can't be reached from a render live here; the
    // panel's own dialog role, focus handling and row behavior are covered
    // behaviorally in CopyTreeRecentsPanel.test.tsx. Toolbar.tsx is too large
    // to mount in jsdom, which is the reason this file reads source at all.

    it("never replays a recent against the worktree stored on the record", () => {
      // The history dedupe key covers options alone, so `record.worktreeId` is
      // whichever worktree ran it last — provenance, not a stable target, and
      // possibly one that no longer exists. File-wide rather than block-scoped:
      // the field must not be read anywhere in the toolbar, however the handler
      // is later refactored or extracted.
      expect(source).toContain("handleCopyTreeWithOptions(activeWorktree, record.options");
      expect(source).not.toContain("record.worktreeId");
    });

    it("closes the panel wherever a sibling dropdown is closed on overflow eviction", () => {
      // Relational, and the reason it matters: the panel is portaled to
      // document.body, so the wrapper's `invisible absolute` eviction styles
      // never reach it. Whatever set of ids that effect closes, copy-tree
      // belongs in it — asserted against its neighbours rather than as a
      // standalone literal, so deleting the effect fails here too.
      const evictionEffect = source.match(
        /Close open dropdowns when their buttons move into overflow[\s\S]*?\}, \[leftOverflow, rightOverflow\]\);/
      );
      expect(evictionEffect).not.toBeNull();
      expect(evictionEffect![0]).toContain('overflowSet.has("notification-center")');
      expect(evictionEffect![0]).toContain('overflowSet.has("copy-tree")');
    });

    it("gates opening the panel on the same condition the trigger reports as disabled", () => {
      // The shared Button doesn't suppress clicks on aria-disabled alone, so a
      // trigger that announces "disabled" while copying must also refuse to
      // open — otherwise the panel appears and every row silently declines.
      const copyTreeBlock = source.match(/"copy-tree":\s*\{[\s\S]*?isAvailable/);
      expect(copyTreeBlock).not.toBeNull();
      const ariaDisabled = copyTreeBlock![0].match(/aria-disabled=\{([^}]+)\}/);
      expect(ariaDisabled).not.toBeNull();

      const toggle = source.match(/const handleCopyTreeToggle = useCallback\([\s\S]*?\n {2}\);/);
      expect(toggle).not.toBeNull();
      // Every condition the button announces as disabling must also gate the
      // toggle. `undefined` is the JSX spelling of "not disabled", not a term.
      for (const term of ariaDisabled![1]!.split("||").map((t) => t.trim())) {
        if (term === "undefined") continue;
        expect(toggle![0]).toContain(term.replace(/^!/, ""));
      }
    });
  });

  describe("sidebar toggle drops always-on armed highlight — issue #8357", () => {
    it("marks the sidebar toggle button with data-sidebar-toggle", () => {
      const sidebarBlock = source.match(/"sidebar-toggle":\s*\{[\s\S]*?isAvailable/);
      expect(sidebarBlock).not.toBeNull();
      expect(sidebarBlock![0]).toContain("data-sidebar-toggle");
    });

    it("retains aria-pressed on the sidebar toggle for accessibility", () => {
      const sidebarBlock = source.match(/"sidebar-toggle":\s*\{[\s\S]*?isAvailable/);
      expect(sidebarBlock).not.toBeNull();
      expect(sidebarBlock![0]).toContain("aria-pressed={!isFocusMode}");
    });

    it("carves both sidebar toggles out of the armed rules in toolbar.css (#8357, #11328)", async () => {
      const css = await fs.readFile(TOOLBAR_CSS_PATH, "utf-8");
      // The app sidebar toggle uses aria-pressed; the file-browser tree toggle
      // uses aria-expanded (a disclosure). Both carry data-sidebar-toggle and
      // must be excluded so neither shows a persistent armed chip.
      const pressedOptOut = css.match(
        /\.toolbar-icon-button\[aria-pressed="true"\]:where\(:not\(\[data-sidebar-toggle\]\)\)/g
      );
      const expandedOptOut = css.match(
        /\.toolbar-icon-button\[aria-expanded="true"\]:where\(:not\(\[data-sidebar-toggle\]\)\)/g
      );
      // Relational invariant: wherever the pressed rule is carved out (base,
      // light, forced-colors), the expanded rule is too — so reverting one
      // block's aria-expanded selector to the un-excluded form fails here.
      expect(expandedOptOut?.length ?? 0).toBeGreaterThan(0);
      expect(expandedOptOut?.length).toBe(pressedOptOut?.length);
      // Neither icon-button carve-out may regress to an un-excluded standalone selector.
      expect(css).not.toMatch(/\.toolbar-icon-button\[aria-pressed="true"\],/);
      expect(css).not.toMatch(/\.toolbar-icon-button\[aria-expanded="true"\],/);
      // Agent-button armed selectors stay intact so dropdowns keep the highlight.
      expect(css).toContain('.toolbar-agent-button[aria-pressed="true"]');
      expect(css).toContain('.toolbar-agent-button[aria-expanded="true"]');
    });
  });

  describe("useMemo dependency array", () => {
    it("includes sidebarShortcut in useMemo deps", () => {
      const depsMatch = source.match(/\}\),\s*\[([^\]]+)\]\s*\);/s);
      expect(depsMatch).not.toBeNull();
      const deps = depsMatch![1];
      expect(deps).toContain("sidebarShortcut");
    });

    it("includes copyTreeShortcut in useMemo deps", () => {
      const depsMatch = source.match(/\}\),\s*\[([^\]]+)\]\s*\);/s);
      expect(depsMatch).not.toBeNull();
      const deps = depsMatch![1];
      expect(deps).toContain("copyTreeShortcut");
    });

    it("includes showCopyingSpinner in useMemo deps (issue #8179)", () => {
      const depsMatch = source.match(/\}\),\s*\[([^\]]+)\]\s*\);/s);
      expect(depsMatch).not.toBeNull();
      const deps = depsMatch![1];
      expect(deps).toContain("showCopyingSpinner");
    });

    it("diagnosticsShortcut is in ToolbarProblemsButton", () => {
      expect(problemsSource).toContain('useKeybindingDisplay("panel.toggleDiagnostics")');
    });

    it("portalShortcut is in ToolbarPortalButton", () => {
      expect(portalSource).toContain('useKeybindingDisplay("panel.togglePortal")');
    });

    it("settingsShortcut is in ToolbarSettingsButton", () => {
      expect(settingsSource).toContain('useKeybindingDisplay("app.settings")');
    });
  });

  // PluginToolbarButton moved to PluginTrayButton.tsx in #11304, alongside the
  // tray that now owns un-promoted contributions.
  describe("PluginToolbarButton aria-keyshortcuts — issue #8938", () => {
    it("calls useAriaKeyshortcuts with the plugin actionId", () => {
      expect(pluginTraySource).toContain("useAriaKeyshortcuts(config.actionId)");
    });

    it("renders aria-keyshortcuts on the plugin Button", () => {
      expect(pluginTraySource).toContain("aria-keyshortcuts={ariaShortcut}");
    });

    it("drops the redundant `as string` cast on the hover hook", () => {
      expect(pluginTraySource).not.toContain("useShortcutHintHover(config.actionId as string)");
    });
  });

  describe("VoiceRecordingToolbarButton hint-hover — issue #8938", () => {
    it("imports useShortcutHintHover", () => {
      expect(voiceSource).toContain("useShortcutHintHover");
    });

    it("calls useShortcutHintHover with the voice-input actionId", () => {
      expect(voiceSource).toContain('useShortcutHintHover("voiceInput.toggle")');
    });

    it("spreads hover handlers onto the Button", () => {
      expect(voiceSource).toContain("{...hover}");
    });
  });

  describe("AgentButton hint-hover — issue #8938", () => {
    it("calls useShortcutHintHover keyed off the agent type", () => {
      expect(agentSource).toContain("useShortcutHintHover(`agent.${type}`)");
    });

    it("composes hover.onPointerEnter alongside clearFocusRestoreSuppression", () => {
      const composed = agentSource.match(
        /onPointerEnter=\{\(e\) => \{\s*clearFocusRestoreSuppression\(\);\s*hover\.onPointerEnter\(e\);\s*\}\}/g
      );
      expect(composed).not.toBeNull();
      expect(composed!.length).toBeGreaterThanOrEqual(2);
    });

    it("wires the remaining hover handlers explicitly on the primary Button(s)", () => {
      const leaveMatches = agentSource.match(/onPointerLeave=\{hover\.onPointerLeave\}/g) ?? [];
      const downMatches = agentSource.match(/onPointerDown=\{hover\.onPointerDown\}/g) ?? [];
      const focusMatches = agentSource.match(/onFocus=\{hover\.onFocus\}/g) ?? [];
      const blurMatches = agentSource.match(/onBlur=\{hover\.onBlur\}/g) ?? [];
      expect(leaveMatches.length).toBeGreaterThanOrEqual(2);
      expect(downMatches.length).toBeGreaterThanOrEqual(2);
      expect(focusMatches.length).toBeGreaterThanOrEqual(2);
      expect(blurMatches.length).toBeGreaterThanOrEqual(2);
    });

    it("leaves the chevron DropdownMenuTrigger Button without hover hint wiring", () => {
      // Chevron keeps the lone onPointerEnter={clearFocusRestoreSuppression}
      // form — no hover spread, since the chevron has no shortcut hint surface.
      expect(agentSource).toContain("onPointerEnter={clearFocusRestoreSuppression}");
    });
  });
});
