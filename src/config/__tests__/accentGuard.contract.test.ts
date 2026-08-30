import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const PLUGIN_RENDERER_ROOTS = [path.join(REPO_ROOT, "plugins/builtin/github/renderer")];

// ── Forbidden accent token patterns ────────────────────────────────────

// Both vocabularies stay listed: #12031 renamed every solid call site to the
// semantic spelling, but the alpha-modified legacy forms it left behind
// (`ring-daintree-accent/30`, `border-daintree-accent/40`) are still accent.
const FORBIDDEN_UTILITIES = [
  "bg-daintree-accent",
  "text-daintree-accent",
  "border-daintree-accent",
  "ring-daintree-accent",
  "outline-daintree-accent",
  "fill-daintree-accent",
  "bg-accent-primary",
  "text-accent-primary",
  "border-accent-primary",
  "ring-accent-primary",
  "outline-accent-primary",
  "fill-accent-primary",
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
const FOCUS_RING_UTILITIES: readonly string[] = [
  "border-daintree-accent",
  "ring-daintree-accent",
  "outline-daintree-accent",
  "border-accent-primary",
  "ring-accent-primary",
  "outline-accent-primary",
];

function isFocusRing(context: string, matchIndex: number, utility: string): boolean {
  if (!FOCUS_RING_UTILITIES.includes(utility)) {
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

// Cleanup issues that have been closed/completed. ALLOWLIST_BY_ISSUE must not
// contain any single-issue key matching ^#\d+$ that appears here — add new
// entries as cleanup issues close. Compound sentinel keys (e.g.
// "#5978-5986-pre-existing") are exempt from the check.
const KNOWN_CLOSED_ISSUES = new Set([
  "#5978",
  "#5979",
  "#5980",
  "#5981",
  "#5982",
  "#5983",
  "#5984",
  "#5985",
  "#5986",
]);

// Legitimate accent usage that will persist after all cleanup PRs land.
// Each entry must carry a brief rationale.
const DURABLE_ALLOWLIST = new Set([
  // Theme browser accent display (theme content, not app chrome)
  "src/components/ThemeBrowser/ThemeBrowser.tsx",

  // Primary CTA (QuickRun button) + bg-accent-soft autocomplete + fill-daintree-accent Pin icon
  "src/components/Project/QuickRun.tsx",

  // PluginManagerView selected-row left-edge accent stripe in the master-detail
  // list, plus the detail subtab active-tab underline (single primary anchor per
  // active focus region)
  "src/components/Plugin/PluginManagerView.tsx",

  // PresetColorPicker Done CTA (primary commit action) + focus-visible ring
  "src/components/Settings/PresetColorPicker.tsx",

  // Current rebase step indicator in the conflict UI (single primary anchor per active focus region)
  "src/components/Worktree/ReviewHub/ConflictPanel.tsx",

  // Find bar match-case toggle active state (single primary anchor per active focus region)
  "src/components/Browser/FindBar.tsx",

  // File-browser tree-column resize handle: focus ring + grip accent mark the
  // one keyboard-focusable separator (single focus anchor per active focus
  // region), mirroring the PortalDock/Sidebar resize-handle convention (#11331)
  "src/panels/file-browser/FileBrowserPane.tsx",

  // Worktree overview grid: the active-descendant cursor. The grid is a single
  // tab stop whose 2D arrow keys move `aria-activedescendant`, so the cursor is
  // NOT DOM focus and cannot be written as a `focus-visible:` variant the way
  // the auto-exclusion above expects. It is nonetheless the one load-bearing
  // anchor in that arrow-key domain, which is what accent is reserved for.
  // Membership deliberately takes a neutral tint plus inset ring instead, so
  // the two marks cannot be confused with each other (#11989).
  "src/components/Worktree/WorktreeOverviewModal.tsx",
]);

// Pre-existing accent usage inherited from cleanup buckets #5978-#5986 (all
// closed/completed as of 2026-04-28). New cleanup PRs should remove files
// from this sentinel as accent is migrated away — the stale-file ratchet
// (`allowlist hygiene > no stale allowlist entries`) fails if an allowlisted
// file no longer contains any non-focus-ring forbidden utility.
const ALLOWLIST_BY_ISSUE: Record<string, string[]> = {
  "#5978-5986-pre-existing": [
    "plugins/builtin/github/renderer/components/CommitList.tsx",
    "src/components/Commands/CommandBuilder.tsx",
    "src/components/Commands/CommandPicker.tsx",
    "src/components/DevPreview/DevPreviewEmptyStates.tsx",
    "src/components/Diagnostics/DiagnosticsDock.tsx",
    "src/components/Diagnostics/TelemetryContent.tsx",
    "src/components/Fleet/FleetArmingRibbon.tsx",
    "src/components/KeyboardShortcuts/SettingsShortcutCapture.tsx",
    "src/components/Layout/DockedNonPtyPanelItem.tsx",
    "src/components/Layout/DockedTabGroup.tsx",
    "src/components/Layout/DockedTerminalItem.tsx",
    "src/components/Layout/Sidebar.tsx",
    "src/components/Layout/VoiceRecordingToolbarButton.tsx",
    "src/components/Onboarding/GettingStartedChecklist.tsx",
    "src/components/Panel/PanelHeader.tsx",
    "src/components/Panel/PanelTransitionOverlay.tsx",
    "src/components/Panel/TabButton.tsx",
    "src/components/Portal/PortalDock.tsx",
    "src/components/Portal/PortalToolbar.tsx",
    "src/components/Project/GeneralTab.tsx",
    "src/components/Project/ProjectNotificationsTab.tsx",
    "src/components/Project/WelcomeScreen.tsx",
    "src/components/Recovery/CrashRecoveryDialog.tsx",
    "src/components/Settings/AgentSelectorDropdown.tsx",
    "src/components/Settings/EditorIntegrationTab.tsx",
    "src/components/Settings/EnvVarEditor.tsx",
    "src/components/Settings/ImageViewerTab.tsx",
    "src/components/Settings/KeyboardShortcutsTab.tsx",
    "src/components/Settings/PortalSettingsTab.tsx",
    "src/components/Settings/PresetSelector.tsx",
    "src/components/Settings/PrivacyDataTab.tsx",
    "src/components/Settings/SettingsDialog.tsx",
    "src/components/Settings/SettingsSubtabBar.tsx",
    "src/components/Settings/SettingsSwitchCard.tsx",
    "src/components/Settings/TerminalSettingsTab.tsx",
    "src/components/Settings/WorktreeSettingsTab.tsx",
    "src/components/Terminal/ContentGridDefault.tsx",
    "src/components/Terminal/ContentGridTwoPaneSplit.tsx",
    "src/components/Terminal/HybridInputBar.tsx",
    "src/components/Terminal/RecipeRunner/RecipeRunnerGrid.tsx",
    "src/components/Terminal/RecipeRunner/RecipeRunnerItem.tsx",
    "src/components/Terminal/RecipeRunner/RecipeRunnerList.tsx",
    "src/components/Terminal/TwoPaneSplitDivider.tsx",
    "src/components/Terminal/VoiceInputButton.tsx",
    "src/components/TerminalRecipe/RecipeEditor.tsx",
    "src/components/Worktree/QuickCreatePalette.tsx",
    "src/components/Worktree/WorktreeCard/WorktreeTerminalSection.tsx",
    "src/components/Worktree/WorktreeFilterPopover.tsx",
    "src/hooks/useUpdateListener.tsx",
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
      "ring-accent-primary",
      "ring-accent-primary/50",
      "outline-accent-primary",
      "fill-daintree-accent",
      "fill-accent-primary",
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
      "accent-accent-primary",
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
      // stacked variants
      "motion-safe:focus-visible:ring-daintree-accent/20",
      // semantic spelling (#12031) — same structural exclusion
      "focus-within:border-accent-primary",
      "focus-visible:ring-accent-primary/20",
      "focus-visible:outline-accent-primary",
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
      // semantic spelling (#12031) — same rules apply
      "hover:border-accent-primary",
      "group-focus:ring-accent-primary",
      "outline-accent-primary",
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

  // ── Allowlist hygiene ────────────────────────────────────────────────

  describe("allowlist hygiene", () => {
    it("has no closed-issue keys in ALLOWLIST_BY_ISSUE", () => {
      const offenders = Object.keys(ALLOWLIST_BY_ISSUE).filter(
        (key) => /^#\d+$/.test(key) && KNOWN_CLOSED_ISSUES.has(key)
      );

      expect(
        offenders,
        `ALLOWLIST_BY_ISSUE contains keys referencing closed issues:\n  ${offenders.join(", ")}\n\n` +
          `Move entries to DURABLE_ALLOWLIST (with rationale) or a sentinel bucket, then delete the key.`
      ).toEqual([]);
    });

    it("has no stale allowlist entries", () => {
      const entries: Array<{ file: string; bucket: string }> = [
        ...Array.from(DURABLE_ALLOWLIST).map((file) => ({
          file,
          bucket: "DURABLE_ALLOWLIST",
        })),
        ...Object.entries(ALLOWLIST_BY_ISSUE).flatMap(([key, files]) =>
          files.map((file) => ({ file, bucket: `ALLOWLIST_BY_ISSUE["${key}"]` }))
        ),
      ];

      const stale: Array<{ file: string; bucket: string; reason: string }> = [];

      for (const { file, bucket } of entries) {
        const abs = path.join(REPO_ROOT, file);
        let source: string;
        try {
          source = fs.readFileSync(abs, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            stale.push({ file, bucket, reason: "file deleted" });
            continue;
          }
          throw err;
        }

        const matches = Array.from(source.matchAll(FORBIDDEN_PATTERN));
        const violations = matches.filter((m) => {
          const { index, utility } = assertAccentMatch(m);
          return !isFocusRing(source, index, utility);
        });

        if (violations.length === 0) {
          stale.push({ file, bucket, reason: "no forbidden utility remains" });
        }
      }

      if (stale.length === 0) return;

      const report = stale
        .sort((a, b) => a.file.localeCompare(b.file))
        .map((s) => `  ${s.bucket}: ${s.file} (${s.reason})`)
        .join("\n");

      expect(
        stale,
        `Found ${stale.length} stale allowlist entries — remove them from their bucket:\n${report}`
      ).toEqual([]);
    });
  });

  // ── Repository scan ──────────────────────────────────────────────────

  it("has no 'per view' phrasing in DURABLE_ALLOWLIST comments", () => {
    const testFile = fs.readFileSync(path.join(TEST_DIR, "accentGuard.contract.test.ts"), "utf8");
    // Extract DURABLE_ALLOWLIST entries: from `const DURABLE_ALLOWLIST = new Set([` to `]);`
    const allowlistMatch = testFile.match(/const DURABLE_ALLOWLIST = new Set\(\[([\s\S]*?)\]\);/);
    if (!allowlistMatch?.[1]) return;

    const violations: number[] = [];
    const lines = allowlistMatch[1].split("\n");
    for (const line of lines) {
      if (line.includes("//") && /\bper view\b/.test(line)) {
        const lineNum = testFile.substring(0, testFile.indexOf(line)).split("\n").length;
        violations.push(lineNum);
      }
    }

    if (violations.length > 0) {
      expect(
        violations,
        `${violations.length} DURABLE_ALLOWLIST comment(s) still use "per view". ` +
          `Replace with "per active focus region".`
      ).toEqual([]);
    }
  });

  it("has DURABLE_ALLOWLIST checklist reference in error message", () => {
    const testFile = fs.readFileSync(path.join(TEST_DIR, "accentGuard.contract.test.ts"), "utf8");
    expect(testFile).toContain("See Design review checklist in docs/themes/theme-system.md.");
  });

  it("has no non-allowlisted accent token usages", () => {
    const fullAllowlist = new Set([
      ...DURABLE_ALLOWLIST,
      ...Object.values(ALLOWLIST_BY_ISSUE).flat(),
    ]);

    const violations = new Map<string, string[]>();

    const scanRoots = [SRC_ROOT, ...PLUGIN_RENDERER_ROOTS];
    const allFiles = scanRoots.flatMap((root) =>
      fs.existsSync(root) ? collectSourceFiles(root) : []
    );

    for (const filePath of allFiles) {
      const source = fs.readFileSync(filePath, "utf8");
      // Normalize to posix-style separators so allowlist hits match on Windows.
      const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");

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
        `Add files to ALLOWLIST_BY_ISSUE (keyed by an open cleanup issue # or the existing ` +
        `pre-existing sentinel) if they will be addressed by follow-up cleanup PRs, or to ` +
        `DURABLE_ALLOWLIST with a rationale comment if the accent usage is legitimate per the ` +
        `Accent Color Restraint policy in CLAUDE.md. When a cleanup lands, remove its file ` +
        `entry — the stale-file ratchet (allowlist hygiene > no stale allowlist entries) ` +
        `will fail until you do. ` +
        `See Design review checklist in docs/themes/theme-system.md.`
    ).toEqual({});
  });
});
