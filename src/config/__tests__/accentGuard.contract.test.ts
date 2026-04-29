import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

// ── Forbidden accent token patterns ────────────────────────────────────

const FORBIDDEN_UTILITIES = [
  "bg-daintree-accent",
  "text-daintree-accent",
  "border-daintree-accent",
  "ring-daintree-accent",
  "outline-daintree-accent",
  "bg-accent-primary",
  "text-accent-primary",
  "border-accent-primary",
  "fill-daintree-accent",
  "bg-accent-soft",
] as const;

// Matches a forbidden accent utility with optional opacity modifier: /10, /50, /[0.15], etc.
const FORBIDDEN_PATTERN = new RegExp(
  `(${FORBIDDEN_UTILITIES.join("|")})(?:\\/(?:\\[[\\d.]+\\]|\\d+))?(?![a-z0-9_-])`,
  "g"
);

type AccentMatch = { index: number; full: string; utility: string };

function assertAccentMatch(m: { 0: string; 1?: string; index?: number } | undefined): AccentMatch {
  if (m === undefined) throw new Error("unexpected: match is undefined");
  const utility = m[1];
  const index = m.index;
  // matchAll with a regex containing a capturing group always populates these
  if (utility === undefined || index === undefined) {
    throw new Error("unexpected: match has no capture group or index");
  }
  return { index, full: m[0], utility };
}

// Focus-ring auto-exclusion: border/ring/outline accent tokens preceded by a focus variant are
// legitimate structural focus indicators. For example: focus:border-daintree-accent,
// focus-visible:ring-daintree-accent/50, focus-within:outline-daintree-accent.
// bg-* and text-* accent tokens with focus variants are still flagged (decorative, not structural).
// group-focus/peer-focus are parent/sibling state selectors, not structural focus rings.
function isFocusRing(context: string, matchIndex: number, utility: string): boolean {
  if (
    !["border-daintree-accent", "ring-daintree-accent", "outline-daintree-accent"].includes(utility)
  ) {
    return false;
  }

  const before = context.substring(0, matchIndex);
  if (!before.endsWith(":")) return false;

  // Walk back to find where the variant starts (preceding space, quote, paren, bracket, or start)
  let i = before.length - 2; // skip the trailing ':'
  while (i >= 0 && !/[\s"'({]/.test(before.charAt(i))) {
    i--;
  }
  const variant = before.substring(i + 1, before.length - 1);

  // Exclude parent/sibling state selectors — only element-own focus pseudo-classes qualify
  if (/\b(group|peer)-focus\b/i.test(variant)) return false;

  return /\bfocus\b/i.test(variant);
}

// ── File collection ────────────────────────────────────────────────────

function collectSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      result.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (!/\.(ts|tsx|css)$/.test(entry.name)) continue;
    if (/\.(test|spec)\./.test(entry.name)) continue;

    result.push(fullPath);
  }

  return result;
}

// ── Allowlists ─────────────────────────────────────────────────────────

// Legitimate accent usage that will persist after all cleanup PRs land.
// Each entry must carry a brief rationale.
const DURABLE_ALLOWLIST = new Set([
  // Theme picker swatch data (theme content, not app chrome)
  "src/components/Settings/AppThemePicker.tsx",

  // Theme browser accent display (theme content, not app chrome)
  "src/components/ThemeBrowser/ThemeBrowser.tsx",

  // Primary CTA (QuickRun button) + bg-accent-soft autocomplete + fill-daintree-accent Pin icon
  "src/components/Project/QuickRun.tsx",

  // HealthChip accent tone routing + color-mix CSS custom property usage
  "src/components/Pulse/ProjectPulseCard.tsx",

  // Focused worktree card left-edge accent bar (single primary anchor per view)
  "src/components/Worktree/WorktreeCard.tsx",

  // Setup wizard step indicators, accent icon, telemetry toggle (one-time setup flow)
  "src/components/Setup/AgentSetupWizard.tsx",

  // PresetColorPicker color swatch text accent (interactive state on color picker)
  "src/components/Settings/PresetColorPicker.tsx",
]);

// Files with accent usage that cleanup PRs #5978-5986 will address.
// Organized by cleanup issue for easy batch removal as each PR lands.
// When a cleanup PR removes accent from a file, delete its entry here.
const ALLOWLIST_BY_ISSUE: Record<string, string[]> = {
  // #5978: [settings] In-repo toggle uses triple-accent for ON state
  "#5978": [
    "src/components/Settings/SettingsCheckbox.tsx",
    "src/components/Settings/SettingsChoicebox.tsx",
    "src/components/Settings/SettingsSwitch.tsx",
    "src/components/Settings/SettingsSwitchCard.tsx",
  ],

  // #5979: [pulse] Time-range toggle group uses accent for active selection
  "#5979": [],

  // #5980: [toolbar] Agent buttons use accent on routine hover and focus
  "#5980": [
    "src/components/Layout/Sidebar.tsx",
    "src/components/Layout/Toolbar.tsx",
    "src/components/Layout/VoiceRecordingToolbarButton.tsx",
  ],

  // #5981: [editor] Theme paints caret, headings, and list bullets in chrome accent
  "#5981": [],

  // #5982: [quick-run] Command launcher stacks five accent surfaces
  "#5982": ["src/components/Project/QuickRun.tsx"],

  // #5983: [panels] Inline title-edit border duplicates focus outline
  "#5983": ["src/components/Panel/PanelHeader.tsx", "src/components/Panel/TabButton.tsx"],

  // #5984: [worktree] Drag handle goes accent during sort
  "#5984": [
    "src/components/GitHub/BulkCreateWorktreeDialog.tsx",
    "src/components/Worktree/NewWorktreeDialog.tsx",
    "src/components/DragDrop/DockPlaceholder.tsx",
    "src/components/DragDrop/GridPlaceholder.tsx",
  ],

  // #5985: [panels] Exit Focus badge competes with macro-focus ring
  "#5985": ["src/components/Panel/PanelTransitionOverlay.tsx"],

  // #5986: [onboarding] Theme card checkmark uses accent inconsistent with #5955
  "#5986": [
    "src/components/Onboarding/GettingStartedChecklist.tsx",
    "src/components/ThemePalette/ThemePalette.tsx",
  ],

  // Pre-existing accent usage in components not yet covered by a specific cleanup issue.
  // Each cleanup PR should move its files into the matching issue bucket above,
  // then remove them entirely once accent is migrated away.
  "#5978-5986-pre-existing": [
    "src/components/ActionPalette/ActionPaletteItem.tsx",
    "src/components/Browser/WebviewDialog.tsx",
    "src/components/Commands/CommandBuilder.tsx",
    "src/components/Commands/CommandPicker.tsx",
    "src/components/Commands/CommandPickerHost.tsx",
    "src/components/Browser/BrowserPane.tsx",
    "src/components/DevPreview/DevPreviewPane.tsx",
    "src/components/Diagnostics/DiagnosticsDock.tsx",
    "src/components/Diagnostics/TelemetryContent.tsx",
    "src/components/Fleet/FleetArmingDialog.tsx",
    "src/components/Fleet/FleetArmingRibbon.tsx",
    "src/components/GitHub/BulkActionBar.tsx",
    "src/components/GitHub/GitHubDropdownSkeletons.tsx",
    "src/components/GitHub/GitHubListItem.tsx",
    "src/components/GitHub/GitHubResourceList.tsx",
    "src/components/HelpPanel/HelpPanel.tsx",
    "src/components/KeyboardShortcuts/SettingsShortcutCapture.tsx",
    "src/components/LogLevelPalette/LogLevelPalette.tsx",
    "src/components/Notifications/NotificationCenterEntry.tsx",
    "src/components/PanelPalette/PanelPalette.tsx",
    "src/components/Portal/PortalDock.tsx",
    "src/components/Portal/PortalToolbar.tsx",
    "src/components/Project/AutomationTab.tsx",
    "src/components/Project/CloneRepoDialog.tsx",
    "src/components/Project/CreateProjectFolderDialog.tsx",
    "src/components/Project/EnvironmentVariablesEditor.tsx",
    "src/components/Project/GeneralTab.tsx",
    "src/components/Project/GitInitDialog.tsx",
    "src/components/Project/ProjectNotificationsTab.tsx",
    "src/components/Project/ProjectSwitcher.tsx",
    "src/components/Project/ProjectSwitcherPalette.tsx",
    "src/components/Project/WelcomeScreen.tsx",
    "src/components/QuickSwitcher/QuickSwitcherItem.tsx",
    "src/components/Recovery/CrashRecoveryDialog.tsx",
    "src/components/Settings/AddPresetDialog.tsx",
    "src/components/Settings/AgentHelpOutput.tsx",
    "src/components/Settings/AgentSelectorDropdown.tsx",
    "src/components/Settings/AgentSettings.tsx",
    "src/components/Settings/ColorSchemePicker.tsx",
    "src/components/Settings/CommandOverridesTab.tsx",
    "src/components/Settings/DiagnosticsReviewDialog.tsx",
    "src/components/Settings/EditorIntegrationTab.tsx",
    "src/components/Settings/EnvVarEditor.tsx",
    "src/components/Settings/GeneralTab.tsx",
    "src/components/Settings/GitHubSettingsTab.tsx",
    "src/components/Settings/ImageViewerTab.tsx",
    "src/components/Settings/ImportEnvDialog.tsx",
    "src/components/Settings/KeybindingProfileActions.tsx",
    "src/components/Settings/KeyboardShortcutsTab.tsx",
    "src/components/Settings/NotificationSettingsTab.tsx",
    "src/components/Settings/PortalSettingsTab.tsx",
    "src/components/Settings/PresetSelector.tsx",
    "src/components/Settings/PrivacyDataTab.tsx",
    "src/components/Settings/ResourceEnvironmentsSection.tsx",
    "src/components/Settings/SettingsDialog.tsx",
    "src/components/Settings/SettingsInput.tsx",
    "src/components/Settings/settingsSearchUtils.tsx",
    "src/components/Settings/SettingsSection.tsx",
    "src/components/Settings/SettingsSelect.tsx",
    "src/components/Settings/SettingsSubtabBar.tsx",
    "src/components/Settings/SettingsTextarea.tsx",
    "src/components/Settings/TerminalSettingsTab.tsx",
    "src/components/Settings/ToolbarSettingsTab.tsx",
    "src/components/Settings/VoiceInputSettingsTab.tsx",
    "src/components/Settings/WorktreeSettingsTab.tsx",
    "src/components/Setup/AgentCliStep.tsx",
    "src/components/Setup/SystemToolsStep.tsx",
    "src/components/Sidebar/SidebarContent.tsx",
    "src/components/Terminal/AutocompleteMenu.tsx",
    "src/components/Terminal/ContentGrid.tsx",
    "src/components/Terminal/GridNotificationBar.tsx",
    "src/components/Terminal/HybridInputBar.tsx",
    "src/components/Terminal/InlineStatusBanner.tsx",
    "src/components/Terminal/PromptHistoryPalette.tsx",
    "src/components/Terminal/RecipeRunner/RecipeRunnerEmpty.tsx",
    "src/components/Terminal/RecipeRunner/RecipeRunnerGrid.tsx",
    "src/components/Terminal/RecipeRunner/RecipeRunnerItem.tsx",
    "src/components/Terminal/RecipeRunner/RecipeRunnerList.tsx",
    "src/components/Terminal/SendToAgentPalette.tsx",
    "src/components/Terminal/TerminalHeaderContent.tsx",
    "src/components/Terminal/TerminalPane.tsx",
    "src/components/Terminal/TerminalRestartStatusBanner.tsx",
    "src/components/Terminal/TwoPaneSplitDivider.tsx",
    "src/components/Terminal/UpdateCwdDialog.tsx",
    "src/components/Terminal/VoiceInputButton.tsx",
    "src/components/TerminalPalette/NewTerminalPalette.tsx",
    "src/components/TerminalRecipe/RecipeEditor.tsx",
    "src/components/ui/ReEntrySummary.tsx",
    "src/components/ui/toaster.tsx",
    "src/components/Worktree/IssuePickerDialog.tsx",
    "src/components/Worktree/QuickCreatePalette.tsx",
    "src/components/Worktree/QuickStateFilterBar.tsx",
    "src/components/Worktree/WorktreeCard/GitHubTooltipContent.tsx",
    "src/components/Worktree/WorktreeCard/WorktreeHeader.tsx",
    "src/components/Worktree/WorktreeCard/WorktreeTerminalSection.tsx",
    "src/components/Worktree/WorktreeDeleteDialog.tsx",
    "src/components/Worktree/WorktreeFilterPopover.tsx",
    "src/components/Worktree/WorktreeOverviewModal.tsx",
    "src/components/Worktree/WorktreePalette.tsx",
    "src/hooks/useUpdateListener.tsx",
    "src/components/agents/AgentCard.tsx",
    "src/components/DragDrop/SortableTerminal.tsx",
    "src/components/GitHub/CommitList.tsx",
    "src/components/Layout/ContentDock.tsx",
    "src/components/Layout/DockedTabGroup.tsx",
    "src/components/Layout/DockedTerminalItem.tsx",
    "src/components/Project/ProjectMruSwitcherOverlay.tsx",
    "src/components/Pulse/PulseHeatmap.tsx",
  ],
};

describe("accent guard", () => {
  // ── Self-tests: pattern matching ─────────────────────────────────────

  describe("forbidden pattern", () => {
    const positives = [
      "bg-daintree-accent",
      "bg-daintree-accent/10",
      "text-daintree-accent",
      "border-daintree-accent",
      "border-daintree-accent/[0.15]",
      "ring-daintree-accent",
      "ring-daintree-accent/50",
      "outline-daintree-accent",
      "bg-accent-primary",
      "text-accent-primary",
      "border-accent-primary",
      "fill-daintree-accent",
      "bg-accent-soft",
      "bg-accent-soft/20",
      // With variants — utility should still be matched
      "hover:bg-daintree-accent",
      "before:bg-daintree-accent",
      "data-[state=checked]:bg-daintree-accent",
    ] as const;

    const negatives = [
      // Native CSS accent-color property — not a Tailwind color utility
      "accent-daintree-accent",
      // -foreground is a distinct token
      "text-accent-primary-foreground",
      "bg-accent-primary-foreground",
      // CSS custom property references
      "var(--theme-accent-primary)",
      "var(--color-accent-primary)",
      // color-mix() function usage
      "color-mix(in oklab, var(--color-accent-primary) 5%, transparent)",
      // Unrelated tokens
      "bg-daintree-bg",
      "text-daintree-text",
      "border-daintree-border",
      // Arbitrary value with CSS var — not a Tailwind token
      "bg-[var(--theme-accent-primary)]",
    ];

    for (const input of positives) {
      it(`flags ${input}`, () => {
        const matches = Array.from(input.matchAll(FORBIDDEN_PATTERN));
        expect(matches.length, `should have matched: ${input}`).toBeGreaterThan(0);
        // Verify the match is one of the forbidden utilities
        const { utility } = assertAccentMatch(matches[0]);
        expect(FORBIDDEN_UTILITIES).toContain(utility);
      });
    }

    for (const input of negatives) {
      it(`does not flag ${input}`, () => {
        const matches = Array.from(input.matchAll(FORBIDDEN_PATTERN));
        expect(matches.length, `unexpectedly flagged: ${input}`).toBe(0);
      });
    }
  });

  describe("focus ring auto-exclusion", () => {
    const FOCUS_RING_UTILITIES = [
      "border-daintree-accent",
      "ring-daintree-accent",
      "outline-daintree-accent",
    ];

    function isExcluded(input: string): boolean {
      const matches = Array.from(input.matchAll(FORBIDDEN_PATTERN));
      expect(matches.length, `no match found for: ${input}`).toBeGreaterThan(0);
      return matches.every((m) => {
        const { index, utility } = assertAccentMatch(m);
        return isFocusRing(input, index, utility);
      });
    }

    function hasViolation(input: string): boolean {
      const matches = Array.from(input.matchAll(FORBIDDEN_PATTERN));
      expect(matches.length, `no match found for: ${input}`).toBeGreaterThan(0);
      return matches.some((m) => {
        const { index, utility } = assertAccentMatch(m);
        if (!FOCUS_RING_UTILITIES.includes(utility)) return true;
        return !isFocusRing(input, index, utility);
      });
    }

    const excluded = [
      // border focus rings
      "focus:border-daintree-accent",
      "focus:border-daintree-accent/50",
      "focus-visible:border-daintree-accent",
      "focus-within:border-daintree-accent",
      "focus-within:border-daintree-accent/25",
      // ring focus rings
      "focus:ring-daintree-accent/50",
      "focus-visible:ring-daintree-accent/20",
      "focus-within:ring-daintree-accent/30",
      // outline focus rings
      "focus-visible:outline-daintree-accent",
      "focus:outline-daintree-accent",
      // custom focus mechanism
      "data-[macro-focus=true]:ring-daintree-accent/60",
      // stacked variants
      "motion-safe:focus-visible:ring-daintree-accent/20",
    ];

    const stillFlagged = [
      // bg-daintree-accent with focus variant is NOT a focus ring — decorative accent fill
      "focus:bg-daintree-accent",
      "focus-visible:bg-daintree-accent/10",
      // text-daintree-accent with focus variant is NOT a focus ring
      "focus:text-daintree-accent",
      // hover:border-daintree-accent is an interactive state, not a focus ring
      "hover:border-daintree-accent/50",
      // hover:ring-daintree-accent is an interactive state, not a focus ring
      "hover:ring-daintree-accent/40",
      // data attribute state is not a focus ring (checked/selected state, not structural)
      "data-[state=checked]:border-daintree-accent",
      // group-focus is a parent state selector, not an element-own focus ring
      "group-focus:border-daintree-accent",
      "group-focus:ring-daintree-accent/50",
      // peer-focus is a sibling state selector
      "peer-focus:border-daintree-accent",
      // Plain border/ring/outline accent without a variant is never a focus ring
      "border-daintree-accent",
      "ring-daintree-accent",
      "outline-daintree-accent",
    ];

    for (const input of excluded) {
      it(`excludes ${input}`, () => {
        expect(isExcluded(input)).toBe(true);
      });
    }

    for (const input of stillFlagged) {
      it(`flags ${input}`, () => {
        expect(hasViolation(input)).toBe(true);
      });
    }
  });

  describe("composite class strings", () => {
    it("flags bg-daintree-accent alongside an excluded focus ring", () => {
      const input = "focus-visible:outline-daintree-accent bg-daintree-accent";
      const matches = Array.from(input.matchAll(FORBIDDEN_PATTERN));
      const violations = matches.filter((m) => {
        const { index, utility } = assertAccentMatch(m);
        return !isFocusRing(input, index, utility);
      });
      expect(violations.length).toBe(1);
      const { utility } = assertAccentMatch(violations[0]);
      expect(utility).toBe("bg-daintree-accent");
    });

    it("excludes focus ring but flags accent text in the same string", () => {
      const input = "focus:border-daintree-accent text-daintree-accent";
      const matches = Array.from(input.matchAll(FORBIDDEN_PATTERN));
      const violations = matches.filter((m) => {
        const { index, utility } = assertAccentMatch(m);
        return !isFocusRing(input, index, utility);
      });
      expect(violations.length).toBe(1);
      const { utility } = assertAccentMatch(violations[0]);
      expect(utility).toBe("text-daintree-accent");
    });

    it("flags data-[state=checked]:border-daintree-accent (checkbox state is not a focus ring)", () => {
      const input =
        "data-[state=checked]:border-daintree-accent data-[state=checked]:bg-daintree-accent";
      const matches = Array.from(input.matchAll(FORBIDDEN_PATTERN));
      const violations = matches.filter((m) => {
        const { index, utility } = assertAccentMatch(m);
        return !isFocusRing(input, index, utility);
      });
      expect(violations.length).toBe(2);
    });

    it("excludes ring focus ring but flags decorative ring in same string", () => {
      const input = "focus:ring-daintree-accent/50 ring-daintree-accent/30";
      const matches = Array.from(input.matchAll(FORBIDDEN_PATTERN));
      const violations = matches.filter((m) => {
        const { index, utility } = assertAccentMatch(m);
        return !isFocusRing(input, index, utility);
      });
      expect(violations.length).toBe(1);
      const { full } = assertAccentMatch(violations[0]);
      expect(full).toBe("ring-daintree-accent/30");
    });

    it("flags group-focus:ring-daintree-accent (parent state, not a focus ring)", () => {
      const input = "group-focus:ring-daintree-accent/50";
      const matches = Array.from(input.matchAll(FORBIDDEN_PATTERN));
      const violations = matches.filter((m) => {
        const { index, utility } = assertAccentMatch(m);
        return !isFocusRing(input, index, utility);
      });
      expect(violations.length).toBe(1);
    });
  });

  // ── Repository scan ──────────────────────────────────────────────────

  it("has no non-allowlisted accent token usages", () => {
    const fullAllowlist = new Set([
      ...DURABLE_ALLOWLIST,
      ...Object.values(ALLOWLIST_BY_ISSUE).flat(),
    ]);

    const violations = new Map<string, string[]>();

    for (const filePath of collectSourceFiles(SRC_ROOT)) {
      const source = fs.readFileSync(filePath, "utf8");
      const relativePath = path.relative(REPO_ROOT, filePath);

      if (fullAllowlist.has(relativePath)) continue;

      const matches = Array.from(source.matchAll(FORBIDDEN_PATTERN));

      for (const match of matches) {
        const { index, utility, full: token } = assertAccentMatch(match);

        if (isFocusRing(source, index, utility)) {
          continue;
        }

        const existing = violations.get(relativePath);
        if (existing) {
          if (!existing.includes(token)) existing.push(token);
        } else {
          violations.set(relativePath, [token]);
        }
      }
    }

    if (violations.size === 0) return;

    const report = Array.from(violations.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, tokens]) => `  ${file}: [${tokens.join(", ")}]`)
      .join("\n");

    expect(
      Object.fromEntries(violations),
      `Found ${violations.size} files with non-allowlisted accent tokens:\n${report}\n\n` +
        `Add files to ALLOWLIST_BY_ISSUE (keyed by cleanup issue #) if they will be addressed ` +
        `by cleanup PRs #5978-5986, or to DURABLE_ALLOWLIST if the accent usage is legitimate ` +
        `per the Accent Color Restraint policy in CLAUDE.md.`
    ).toEqual({});
  });
});
