import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const PLUGIN_RENDERER_ROOTS = [path.join(REPO_ROOT, "plugins/builtin/github/renderer")];

// `outline-hidden` removes the focus outline entirely. Without a same-element focus
// fallback (`focus:`, `focus-visible:`, `focus-within:`, or the codebase's
// `data-[macro-focus=*]:` macro-focus mechanism) the element becomes invisible to
// keyboard users. This contract scans for bare `outline-hidden` and requires an
// element-owned focus indicator in the same className expression.

const OUTLINE_HIDDEN_PATTERN = /\boutline-hidden\b/g;

// Element-owned focus pseudo-class variants. Excludes `group-focus`/`peer-focus`
// (parent/sibling state, not structural focus on the element itself), matching the
// existing `isFocusRing` precedent in `accentGuard.contract.test.ts`.
//
// The negative lookahead excludes "suppressor" utilities that hide the focus
// outline without replacing it — `focus:outline-hidden`, `focus:outline-none`,
// `focus:ring-0` etc. are not real focus indicators, so a string whose ONLY
// `focus:` token is a suppressor must still be flagged as missing a fallback.
const FOCUS_VARIANT_PATTERN =
  /(?<![\w-])focus(?:-visible|-within)?:(?!(?:outline-hidden|outline-none|ring-0|border-transparent)\b)/;

// Codebase macro-focus mechanism (TerminalDockRegion, HelpPanel) — paints a ring
// via `data-[macro-focus=true]:ring-*` when the macro-focus app state owns the
// region. Functions as a valid focus indicator on the element.
const MACRO_FOCUS_PATTERN = /data-\[macro-focus[^\]]*\]:/;

// ── className context extraction ───────────────────────────────────────

// Extract the className expression containing `matchPos`. Strategy:
//   1. Find the enclosing string literal (single/double/backtick) — every
//      Tailwind utility lives inside a string, so this is the stable anchor.
//   2. If that string literal is an argument to a class-helper call
//      (`cn(`/`clsx(`/`classnames(`/`twMerge(`/`cva(`), expand to the whole
//      call so a focus fallback in a sibling string argument is captured.
//   3. Otherwise return just the enclosing string literal — bounds the scan
//      to one className value and prevents bleed into adjacent JSX elements.
//
// Falls back to a small char window only if no enclosing string literal is
// found (defensive — every real `outline-hidden` occurrence is inside a string).
const HELPER_CALL_NAMES = new Set(["cn", "clsx", "classnames", "twMerge", "cva"]);

function findEnclosingStringStart(source: string, pos: number): number {
  // Walk back to the nearest unescaped quote — the opening of the enclosing
  // string literal. Quotes inside a string are escaped, so the first unescaped
  // quote walking back is reliably the opener.
  for (let i = pos; i >= 0; i--) {
    const ch = source[i];
    if (ch !== '"' && ch !== "'" && ch !== "`") continue;
    if (i > 0 && source[i - 1] === "\\") continue;
    return i;
  }
  return -1;
}

function findStringEnd(source: string, start: number): number {
  const quote = source[start]!;
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i;
    i++;
  }
  return source.length - 1;
}

// Walk backward from `beforePos`, skipping string literals and balanced
// parens/braces/brackets, until we find an unmatched `(`. If that `(` is
// preceded by a class-helper-call name, return the full call range. Otherwise
// return null. This correctly traverses sibling `cn()` arguments to find the
// enclosing helper call even when the match is inside the 3rd or 4th string arg.
function findEnclosingHelperCall(
  source: string,
  beforePos: number
): { start: number; end: number } | null {
  const MIN = Math.max(0, beforePos - 4000);
  let i = beforePos - 1;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;

  while (i >= MIN) {
    const ch = source[i]!;

    if (ch === '"' || ch === "'" || ch === "`") {
      // Walk back to this string's opening quote.
      let j = i - 1;
      while (j >= 0) {
        if (source[j] === ch && (j === 0 || source[j - 1] !== "\\")) break;
        j--;
      }
      i = j - 1;
      continue;
    }

    if (ch === ")") {
      parenDepth++;
      i--;
      continue;
    }
    if (ch === "}") {
      braceDepth++;
      i--;
      continue;
    }
    if (ch === "]") {
      bracketDepth++;
      i--;
      continue;
    }
    if (ch === "(") {
      if (parenDepth === 0) {
        // Unmatched `(` — check whether it's a class-helper-call.
        let nameEnd = i - 1;
        while (nameEnd >= 0 && /\s/.test(source[nameEnd]!)) nameEnd--;
        let nameStart = nameEnd;
        while (nameStart >= 0 && /[\w$]/.test(source[nameStart]!)) nameStart--;
        nameStart++;
        const funcName = nameEnd >= nameStart ? source.slice(nameStart, nameEnd + 1) : "";
        if (!HELPER_CALL_NAMES.has(funcName)) return null;

        // Walk forward from `(` to the matching `)`, skipping strings.
        let k = i + 1;
        let depth = 1;
        while (k < source.length && depth > 0) {
          const fch = source[k]!;
          if (fch === '"' || fch === "'" || fch === "`") {
            k = findStringEnd(source, k) + 1;
            continue;
          }
          if (fch === "(") depth++;
          else if (fch === ")") depth--;
          k++;
        }
        return { start: i, end: k };
      }
      parenDepth--;
      i--;
      continue;
    }
    if (ch === "{") {
      // Unmatched `{` means we crossed the JSX expression boundary
      // (`className={…}`) — stop looking for a helper call.
      if (braceDepth === 0) return null;
      braceDepth--;
      i--;
      continue;
    }
    if (ch === "[") {
      if (bracketDepth === 0) return null;
      bracketDepth--;
      i--;
      continue;
    }

    i--;
  }

  return null;
}

function extractClassExpression(source: string, matchPos: number): string {
  const stringStart = findEnclosingStringStart(source, matchPos);
  if (stringStart === -1) {
    return source.slice(Math.max(0, matchPos - 200), Math.min(source.length, matchPos + 200));
  }
  const stringEnd = findStringEnd(source, stringStart);

  const helperCall = findEnclosingHelperCall(source, stringStart);
  if (helperCall) {
    return source.slice(helperCall.start, Math.min(source.length, helperCall.end));
  }

  return source.slice(stringStart, Math.min(source.length, stringEnd + 1));
}

function hasFocusFallback(expression: string): boolean {
  if (FOCUS_VARIANT_PATTERN.test(expression)) return true;
  if (MACRO_FOCUS_PATTERN.test(expression)) return true;
  return false;
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

    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(test|spec)\./.test(entry.name)) continue;

    result.push(fullPath);
  }

  return result;
}

// ── Allowlist ──────────────────────────────────────────────────────────

// Non-interactive containers and focus-trap surfaces that legitimately suppress
// the focus outline. Each entry is matched by relative path AND a stable substring
// of the className expression to scope the suppression to a specific occurrence.
type FocusRingAllowlistEntry = {
  file: string;
  fragment: string;
  reason: string;
};

const ALLOWLIST: FocusRingAllowlistEntry[] = [
  {
    file: "src/components/Worktree/views/WorktreePathPicker.tsx",
    fragment: "focus:outline-hidden disabled:opacity-50",
    reason:
      "Path input and its browse button are one compound control — the ring is painted once on the wrapper via has-[input:focus-visible], so an element-owned ring here would draw a second ring around the pair",
  },
  {
    file: "src/components/ui/PopoverSearchField.tsx",
    fragment: "h-10 min-w-0 flex-1 bg-transparent text-sm text-daintree-text",
    reason:
      "The field is the popover's whole top strip, so its indicator is painted once on the wrapping label via focus-within — it has to span the panel's full width and take its rounded top corners, which a ring on the bare input cannot do (that ring is precisely what this component replaced)",
  },
  {
    file: "src/components/HelpPanel/HelpPanel.tsx",
    fragment: "relative shrink-0 flex flex-col h-full overflow-hidden outline-hidden",
    reason:
      "Aside container — focus styling is delivered via data-[macro-focus=true] ring on the same element",
  },
  {
    file: "src/components/ui/AppDialog.tsx",
    fragment: '"outline-hidden"',
    reason:
      "Dialog content uses focus trap (tabIndex=-1) — focus is delegated to interactive descendants",
  },
  {
    file: "src/components/ui/emoji-picker.tsx",
    fragment: "relative flex-1 outline-hidden",
    reason:
      "Radix emoji-picker Viewport is a presentational container — focus lives on the inner search input",
  },
  {
    file: "src/components/Portal/PortalDock.tsx",
    fragment: "portal-dock outline-hidden",
    reason: "Dock root container — focus is owned by inner panel children, not the dock itself",
  },
  {
    file: "src/components/Layout/TerminalDockRegion.tsx",
    fragment: "outline-hidden data-[macro-focus=true]:ring-2",
    reason: "Macro-focus region — focus indicator is delivered via data-[macro-focus=true] ring",
  },
  {
    file: "src/components/Layout/Sidebar.tsx",
    fragment: "relative w-full h-full flex flex-col outline-hidden overflow-hidden",
    reason: "Sidebar root container — focus lives on interactive descendants (tab nav, buttons)",
  },
  {
    file: "src/components/Worktree/WorktreeCard.tsx",
    fragment: "absolute inset-0 z-0 outline-hidden",
    reason:
      "Inner click-target overlay — keyboard nav handled by the parent focusable card row (#8094)",
  },
  {
    file: "src/components/Worktree/ReviewHub/ReviewHub.tsx",
    fragment: "outline-hidden overflow-hidden",
    reason: "Review hub dialog wrapper — focus trap (tabIndex=-1) delegates focus to content",
  },
  {
    file: "src/components/Worktree/ReviewHub/ReviewHubContent.tsx",
    fragment: "relative flex flex-col flex-1 min-h-0",
    reason: "Review hub content container — focus lives on inner panels and inputs",
  },
  {
    file: "src/components/Worktree/ReviewHub/ReviewHubContent.tsx",
    fragment: '"outline-hidden"',
    reason:
      "Review hub file listbox — roving focus via aria-activedescendant; the active row owns the focus indicator, not the container (tabIndex=-1, programmatic focus only)",
  },
  {
    file: "src/components/Terminal/ContentGridTwoPaneSplit.tsx",
    fragment: "h-full flex flex-col outline-hidden",
    reason: "Grid layout container — focus owned by terminal pane children",
  },
  {
    file: "src/components/Terminal/ContentGridMaximizedGroup.tsx",
    fragment: "h-full flex flex-col bg-daintree-bg outline-hidden",
    reason: "Grid layout container — focus owned by terminal pane children",
  },
  {
    file: "src/components/Terminal/ContentGridFleetScope.tsx",
    fragment: "h-full flex flex-col outline-hidden",
    reason: "Grid layout container — focus owned by terminal pane children",
  },
  {
    file: "src/components/Terminal/ContentGridDefault.tsx",
    fragment: "h-full flex flex-col outline-hidden",
    reason: "Grid layout container — focus owned by terminal pane children",
  },
  {
    file: "src/components/Terminal/ContentGridMaximizedSingle.tsx",
    fragment: "h-full flex flex-col bg-daintree-bg outline-hidden",
    reason: "Grid layout container — focus owned by terminal pane children",
  },
  {
    file: "src/components/Fleet/FleetArmingRibbon.tsx",
    fragment: "relative flex items-center gap-3 overflow-hidden border-b border-daintree-border",
    reason:
      "Status ribbon — focus delegated to child controls (Exit button, count chip, selection-menu trigger); ribbon container uses tabIndex=-1 to receive programmatic focus only",
  },
  {
    file: "src/components/Notifications/NotificationCenter.tsx",
    fragment: "text-daintree-text/50 outline-hidden",
    reason:
      "'New since last looked' chip — non-interactive label; mark-read button inside has its own focus styling",
  },
  {
    file: "src/components/Fleet/FleetPickerContent.tsx",
    fragment: "flex-1 min-h-0 overflow-y-auto px-2 py-2 outline-hidden",
    reason:
      "Listbox container with roving tabindex — focus indicator is owned by the active row, not the container",
  },

  // ── Parent-shows-focus pattern ────────────────────────────────────────
  // Inputs nested inside a wrapper that paints the focus indicator via
  // `focus-within:border-*` / `focus-within:ring-*`. The child input
  // suppresses its own default outline with `focus:outline-hidden` so the
  // wrapper's ring is the only focus indication. The scanner can't see the
  // sibling JSX parent, so these get per-occurrence allowlists.
  {
    file: "src/components/Settings/KeyboardShortcutsTab.tsx",
    fragment:
      "flex-1 min-w-0 text-xs bg-transparent text-daintree-text placeholder:text-text-placeholder focus:outline-hidden",
    reason:
      "Parent shows focus: wrapper at line 230 has `focus-within:border-daintree-accent focus-within:ring-1`",
  },
  {
    file: "src/components/Settings/SettingsDialog.tsx",
    fragment:
      "settings-search-input flex-1 min-w-0 text-xs bg-transparent text-daintree-text focus:outline-hidden",
    reason:
      "Parent shows focus: wrapper at line 578 has `focus-within:border-daintree-accent focus-within:ring-1`",
  },
  {
    file: "src/components/FileViewer/FileViewerModal.tsx",
    fragment:
      "w-44 bg-transparent text-xs text-daintree-text placeholder:text-text-placeholder focus:outline-hidden",
    reason:
      "Parent shows focus: the diff search bar wrapper has `focus-within:border-daintree-accent focus-within:ring-1`",
  },
  {
    file: "src/components/FileViewer/DiffFileSidebar.tsx",
    fragment:
      "w-full bg-transparent text-xs text-daintree-text placeholder:text-text-placeholder focus:outline-hidden",
    reason:
      "Parent shows focus: the sidebar filter wrapper has `focus-within:border-daintree-accent focus-within:ring-1`",
  },
  {
    file: "src/panels/file/FilePane.tsx",
    fragment:
      "w-full bg-transparent text-sm text-daintree-text placeholder:text-text-placeholder focus:outline-hidden",
    reason:
      "Parent shows focus: the markdown file-picker wrapper has `focus-within:border-daintree-accent focus-within:ring-1`",
  },
  {
    file: "src/components/Project/QuickRun.tsx",
    fragment: "focus:outline-hidden min-w-0",
    reason:
      "Parent shows focus: wrapper at line 397 has `focus-within:border-daintree-accent/35 focus-within:ring-1`",
  },
  {
    file: "src/components/ui/AppPaletteDialog.tsx",
    fragment: "focus:outline-hidden focus:border-transparent focus:ring-0",
    reason:
      "Parent shows focus: the prefixed-input wrapper carries `focus-within:border-selection-outline focus-within:ring-1`.",
  },
  {
    file: "src/components/Settings/ColorSchemePicker.tsx",
    fragment:
      "flex-1 min-w-0 text-xs bg-transparent text-daintree-text placeholder:text-text-placeholder focus:outline-hidden",
    reason: "Parent shows focus: wrapper at line 172 has `focus-within:border-daintree-accent`",
  },
  {
    file: "src/components/ThemeBrowser/ThemeBrowser.tsx",
    fragment:
      "flex-1 min-w-0 text-xs bg-transparent text-daintree-text placeholder:text-text-placeholder focus:outline-hidden",
    reason: "Parent shows focus: wrapper at line 477 has `focus-within:border-daintree-accent`",
  },
  {
    file: "src/components/Worktree/WorktreeSidebarSearchBar.tsx",
    fragment:
      "flex-1 min-w-0 text-xs bg-transparent text-daintree-text placeholder-daintree-text/40 focus:outline-hidden",
    reason:
      "Parent shows focus: wrapper at line 141 has `focus-within:border-daintree-accent focus-within:ring-1`",
  },
  {
    file: "src/components/Layout/LocalCommitsDropdown.tsx",
    fragment:
      "flex-1 min-w-0 text-sm bg-transparent text-daintree-text placeholder:text-muted-foreground focus:outline-hidden",
    reason:
      "Parent shows focus: wrapper at line 437 has `focus-within:border-daintree-accent focus-within:ring-1`",
  },

  // ── Pre-existing focus-ring gaps surfaced by #8940 ───────────────────
  // The new contract surfaced these standalone interactive elements that
  // suppress the default focus outline with no replacement. Documented
  // here for follow-up; each is a real keyboard-accessibility gap that
  // should be addressed in a separate cleanup PR.
  {
    file: "src/components/Settings/AgentSelectorDropdown.tsx",
    fragment:
      "flex-1 min-w-0 text-xs bg-transparent text-daintree-text placeholder:text-text-placeholder focus:outline-hidden",
    reason:
      "PRE-EXISTING #8940: autoFocus filter input inside popover lacks a focus indicator — follow-up",
  },
  {
    file: "src/components/Settings/ForgeProviderSelectorDropdown.tsx",
    fragment:
      "flex-1 min-w-0 text-xs bg-transparent text-daintree-text placeholder:text-text-placeholder focus:outline-hidden",
    reason:
      "PRE-EXISTING #8940: autoFocus filter input inside popover lacks a focus indicator — follow-up",
  },
  {
    file: "src/components/Settings/AgentScopeEditor/CustomPresetChrome.tsx",
    fragment:
      "flex-1 text-sm font-medium bg-daintree-bg border border-border-strong rounded px-2 py-0.5 focus:outline-hidden",
    reason: "PRE-EXISTING #8940: preset rename input has no focus indicator — follow-up",
  },
  {
    file: "src/components/Panel/PanelHeader.tsx",
    fragment:
      "text-xs font-medium bg-overlay-soft border border-transparent px-1 h-5 min-w-32 text-daintree-text select-text transition-colors focus:outline-hidden",
    reason:
      "PRE-EXISTING #8940: inline panel title rename input has no focus indicator — follow-up",
  },
  {
    file: "src/components/Panel/TabButton.tsx",
    fragment:
      "text-xs bg-overlay-soft border border-transparent px-1 h-4 min-w-[60px] max-w-[100px] text-daintree-text select-text focus:outline-hidden",
    reason:
      "PRE-EXISTING #8940: tab rename input has no focus indicator (the input is the sole focus target while editing) — follow-up",
  },
  {
    file: "src/components/Project/QuickRun.tsx",
    fragment:
      "text-text-muted transition-colors hover:bg-overlay-soft hover:text-text-secondary focus:outline-hidden",
    reason:
      "PRE-EXISTING #8940: QuickRun expand/collapse header button has no focus indicator — follow-up",
  },
  {
    file: "src/components/Sidebar/SidebarContent.tsx",
    fragment: "flex flex-col flex-1 min-h-0 focus:outline-hidden",
    reason:
      "PRE-EXISTING #8940: keyboard-accessible grid container (tabIndex=0) with no focus indicator — follow-up (HIGH SEVERITY)",
  },
  {
    file: "src/components/Worktree/WorktreeOverviewModal.tsx",
    fragment: '"focus:outline-hidden"',
    reason:
      "PRE-EXISTING #8940: keyboard-accessible grid container (tabIndex=0) with no focus indicator — follow-up (HIGH SEVERITY)",
  },
  {
    file: "src/components/Terminal/HybridInputBar.tsx",
    fragment:
      "select-none pl-2 pr-1 font-mono text-xs font-semibold leading-5 text-daintree-accent/65 hover:text-daintree-accent/85 transition-colors cursor-pointer focus-visible:outline-hidden",
    reason: "PRE-EXISTING #8940: command picker trigger button has no focus indicator — follow-up",
  },
  {
    file: "plugins/builtin/github/renderer/components/CommitList.tsx",
    fragment:
      "flex-1 min-w-0 text-sm bg-transparent text-daintree-text placeholder:text-muted-foreground focus:outline-hidden",
    reason: "PRE-EXISTING #8940: autoFocus commit search input lacks a focus indicator — follow-up",
  },
  {
    file: "plugins/builtin/github/renderer/components/GitHubResourceList.tsx",
    fragment:
      "flex-1 min-w-0 text-sm bg-transparent text-daintree-text placeholder:text-text-secondary focus:outline-hidden",
    reason:
      "RESOLVED, not deferred: the input is a bare transparent field inside a bordered shell, " +
      "and the shell owns the indicator — `focus-within:border-daintree-accent` at full strength, " +
      "the one accent signal this focus region is allowed. A same-element ring would draw a second " +
      "indicator inside the first. Was the #8940 follow-up.",
  },
  {
    file: "src/components/Layout/ChordIndicator.tsx",
    fragment: "focus:outline-hidden",
    reason:
      "Command HUD search input is auto-focused for the HUD's entire lifetime (a modal, single-input command surface) — there is no ambiguous focus state to indicate, and the dark-glass panel is the focus surface.",
  },
];

// ── Tests ──────────────────────────────────────────────────────────────

describe("focus-ring fallback contract", () => {
  // ── Self-tests: focus fallback detection ────────────────────────────

  describe("focus fallback detection", () => {
    const withFallback = [
      // Standard same-string focus variants
      '"outline-hidden focus:ring-2 focus:ring-daintree-accent"',
      '"focus:bg-overlay-emphasis outline-hidden"',
      '"outline-hidden focus-visible:outline focus-visible:outline-2"',
      '"outline-hidden focus-within:ring-1"',
      // Stacked variants
      '"outline-hidden motion-safe:focus-visible:ring-2"',
      // Codebase macro-focus mechanism
      '"outline-hidden data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-daintree-accent/60"',
    ];

    const withoutFallback = [
      // Bare suppression — no focus indicator at all
      '"outline-hidden"',
      // Hover-only — not a focus indicator
      '"outline-hidden hover:ring-1"',
      // Parent/sibling state — not element-owned focus
      '"outline-hidden group-focus:ring-2"',
      '"outline-hidden peer-focus:ring-2"',
      // data-[state=*] is not a focus indicator
      '"outline-hidden data-[state=open]:ring-2"',
      // `focus:outline-hidden` is the suppressor itself, not a replacement indicator
      '"flex-1 text-xs bg-transparent focus:outline-hidden"',
      '"px-2 focus-visible:outline-hidden hover:bg-overlay-soft"',
      // The suppressors `focus:outline-none`, `focus:ring-0`, `focus:border-transparent`
      // are also non-indicators
      '"outline-hidden focus:outline-none"',
      '"outline-hidden focus:ring-0"',
      '"outline-hidden focus:border-transparent"',
    ];

    for (const input of withFallback) {
      it(`accepts ${input}`, () => {
        expect(hasFocusFallback(input)).toBe(true);
      });
    }

    for (const input of withoutFallback) {
      it(`flags ${input}`, () => {
        expect(hasFocusFallback(input)).toBe(false);
      });
    }
  });

  // ── Self-tests: multi-line cn() extraction ──────────────────────────

  describe("multi-line cn() extraction", () => {
    it("captures focus fallback in a sibling cn() argument", () => {
      const source = `<input
        className={cn(
          "w-full bg-transparent outline-hidden",
          "focus:ring-2 focus:ring-daintree-accent"
        )}
      />`;
      const matchPos = source.indexOf("outline-hidden");
      const expression = extractClassExpression(source, matchPos);
      expect(hasFocusFallback(expression)).toBe(true);
    });

    it("captures macro-focus fallback in a sibling cn() argument", () => {
      const source = `<aside
        className={cn(
          "overflow-hidden outline-hidden",
          "bg-daintree-bg border-l border-daintree-border",
          "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-daintree-accent/60"
        )}
      />`;
      const matchPos = source.indexOf("outline-hidden");
      const expression = extractClassExpression(source, matchPos);
      expect(hasFocusFallback(expression)).toBe(true);
    });

    it("does NOT pick up an unrelated focus class in an adjacent JSX element", () => {
      const source = `<div className={cn("outline-hidden")}>
        <button className="focus:ring-2">click</button>
      </div>`;
      const matchPos = source.indexOf("outline-hidden");
      const expression = extractClassExpression(source, matchPos);
      // The button's focus class is in a separate JSX element, outside the cn() — must not bleed in.
      expect(hasFocusFallback(expression)).toBe(false);
    });

    it("does NOT pick up focus on a sibling JSX className expression", () => {
      const source = `<div>
        <span className="outline-hidden" />
        <span className="focus:ring-1" />
      </div>`;
      const matchPos = source.indexOf("outline-hidden");
      const expression = extractClassExpression(source, matchPos);
      expect(hasFocusFallback(expression)).toBe(false);
    });

    it("captures focus in a single-line string", () => {
      const source = `<input className="outline-hidden focus:ring-2" />`;
      const matchPos = source.indexOf("outline-hidden");
      const expression = extractClassExpression(source, matchPos);
      expect(hasFocusFallback(expression)).toBe(true);
    });
  });

  // ── Repository scan ─────────────────────────────────────────────────

  it("every outline-hidden occurrence pairs with an element-owned focus indicator (or is allowlisted)", () => {
    const scanRoots = [SRC_ROOT, ...PLUGIN_RENDERER_ROOTS];
    const allFiles = scanRoots.flatMap((root) =>
      fs.existsSync(root) ? collectSourceFiles(root) : []
    );

    // Sanity-check the scan is hitting real source so a broken path doesn't
    // silently produce zero violations and a vacuous pass.
    expect(allFiles.length, "scan must find source files").toBeGreaterThan(100);
    expect(
      allFiles.some((f) => f.endsWith(path.join("ui", "AppDialog.tsx"))),
      "scan must include known sentinel file (src/components/ui/AppDialog.tsx)"
    ).toBe(true);

    const violations: Array<{ file: string; line: number; snippet: string }> = [];

    for (const filePath of allFiles) {
      const source = fs.readFileSync(filePath, "utf8");
      // Normalize to posix-style separators so allowlist hits match on Windows.
      const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");

      OUTLINE_HIDDEN_PATTERN.lastIndex = 0;
      for (const match of source.matchAll(OUTLINE_HIDDEN_PATTERN)) {
        const matchPos = match.index ?? -1;
        if (matchPos < 0) continue;

        const expression = extractClassExpression(source, matchPos);
        if (hasFocusFallback(expression)) continue;

        const allowlisted = ALLOWLIST.some(
          (entry) => entry.file === relativePath && expression.includes(entry.fragment)
        );
        if (allowlisted) continue;

        const lineNumber = source.slice(0, matchPos).split("\n").length;
        const snippet = source.split("\n")[lineNumber - 1]!.trim();
        violations.push({ file: relativePath, line: lineNumber, snippet });
      }
    }

    if (violations.length === 0) return;

    const detail = violations
      .slice(0, 20)
      .map((v) => `  ${v.file}:${v.line} — ${v.snippet}`)
      .join("\n");
    const more = violations.length > 20 ? `\n  …and ${violations.length - 20} more` : "";

    throw new Error(
      `Found ${violations.length} bare \`outline-hidden\` use(s) with no element-owned focus indicator. ` +
        `Add a same-element focus fallback (e.g. \`focus-visible:ring-2 focus-visible:ring-daintree-accent\`) ` +
        `or, if the element is non-interactive and delegates focus, add an ALLOWLIST entry with a rationale ` +
        `in src/config/__tests__/focusRingFallback.contract.test.ts:\n${detail}${more}`
    );
  });

  /**
   * Tailwind v4 compiles the outline utilities through a registered custom property:
   *
   *   @property --tw-outline-style { syntax:"*"; inherits:false; initial-value:solid }
   *   .outline-hidden                     { --tw-outline-style:none; outline-style:none }
   *   .focus-visible\:outline:focus-visible   { outline-style:var(--tw-outline-style); … }
   *   .focus-visible\:outline-2:focus-visible { outline-style:var(--tw-outline-style); … }
   *
   * The property does not inherit, so `outline-hidden` sets it to `none` on the very
   * element the focus utilities then read it from. An element carrying both resolves to
   * `outline-style: none` under `:focus-visible` — correct colour, correct width, correct
   * offset, and nothing painted. The test above does not catch this: it sees a
   * `focus-visible:outline*` utility and calls the fallback satisfied.
   *
   * A ring-based fallback (`focus-visible:ring-*`) is box-shadow and unaffected.
   */
  it("an outline-based focus fallback restates the outline style", () => {
    const OUTLINE_FOCUS_UTILITY = /focus(?:-visible)?:outline(?:-\d+)?(?=[\s"'`])/;

    /**
     * Expressions where the suppressor and the outline fallback are the two arms of a
     * ternary, so they can never apply to the same element at the same time. The
     * extractor sees one class expression and cannot tell the arms apart.
     */
    const TERNARY_ARMS: ReadonlyArray<{ file: string; fragment: string; reason: string }> = [
      {
        file: "src/components/ui/AppPaletteDialog.tsx",
        fragment: "focus:outline-hidden",
        reason:
          "The outline fallback and `focus:outline-hidden` are the two arms of the " +
          '`focusIndicator === "region"` ternary. Whichever arm renders, the other\'s ' +
          "classes are absent, so `--tw-outline-style` keeps its `solid` initial value.",
      },
    ];
    for (const entry of TERNARY_ARMS) {
      expect(entry.reason.trim().length, `${entry.file} needs a rationale`).toBeGreaterThan(0);
      expect(
        fs.readFileSync(path.join(REPO_ROOT, entry.file), "utf8").includes(entry.fragment),
        `stale ternary-arm entry: ${entry.file} no longer contains "${entry.fragment}"`
      ).toBe(true);
    }

    const scanRoots = [SRC_ROOT, ...PLUGIN_RENDERER_ROOTS];
    const allFiles = scanRoots.flatMap((root) =>
      fs.existsSync(root) ? collectSourceFiles(root) : []
    );
    expect(allFiles.length, "scan must find source files").toBeGreaterThan(100);

    const violations: Array<{ file: string; line: number; snippet: string }> = [];

    for (const filePath of allFiles) {
      const source = fs.readFileSync(filePath, "utf8");
      const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");

      OUTLINE_HIDDEN_PATTERN.lastIndex = 0;
      for (const match of source.matchAll(OUTLINE_HIDDEN_PATTERN)) {
        const matchPos = match.index ?? -1;
        if (matchPos < 0) continue;

        const expression = extractClassExpression(source, matchPos);
        if (!OUTLINE_FOCUS_UTILITY.test(expression)) continue;
        if (expression.includes("outline-solid")) continue;
        if (
          TERNARY_ARMS.some(
            (entry) => entry.file === relativePath && expression.includes(entry.fragment)
          )
        )
          continue;

        const lineNumber = source.slice(0, matchPos).split("\n").length;
        const snippet = source.split("\n")[lineNumber - 1]!.trim();
        violations.push({ file: relativePath, line: lineNumber, snippet });
      }
    }

    if (violations.length === 0) return;

    const detail = violations
      .slice(0, 20)
      .map((v) => `  ${v.file}:${v.line} — ${v.snippet}`)
      .join("\n");
    const more = violations.length > 20 ? `\n  …and ${violations.length - 20} more` : "";

    throw new Error(
      `Found ${violations.length} element(s) whose focus ring resolves to \`outline-style: none\`: ` +
        `\`outline-hidden\` sets \`--tw-outline-style: none\` on the element, and ` +
        `\`focus-visible:outline-2\` reads that same value. Add \`focus-visible:outline-solid\` ` +
        `(or switch the fallback to \`focus-visible:ring-*\`):\n${detail}${more}`
    );
  });

  it("every allowlist entry has a non-empty rationale", () => {
    for (const entry of ALLOWLIST) {
      expect(
        entry.reason.trim().length,
        `${entry.file}: rationale must not be empty`
      ).toBeGreaterThan(0);
      expect(
        entry.fragment.trim().length,
        `${entry.file}: fragment must not be empty`
      ).toBeGreaterThan(0);
    }
  });
});
