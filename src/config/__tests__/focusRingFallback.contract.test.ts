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

// ── Highlight-fill quality detectors ───────────────────────────────────
//
// Only Radix sets `data-[highlighted]`, and it does so on pointermove as well as on
// arrow keys, so a weak fill keyed to it is the pointer affordance. What follows
// picks out the keyboard ring that has to sit beside it.
//
// These resolve the ring the way `cn()` does — last token wins its conflict group —
// rather than asking whether a good-looking token appears anywhere in the string.
// The difference is not academic: `cn()` puts the caller's `className` last, so
// "somewhere in here there is an `outline-2`" is satisfied by a row whose effective
// width is the `outline-1` that follows it.

const HIGHLIGHT_FILL_PATTERN = /data-\[highlighted\]:bg-[\w-]+(?:\/(?:\[[\d.]+%?\]|\d+))?/g;

/**
 * Whether a `data-[highlighted]` fill is too faint to be the indicator itself.
 *
 * The overlay ladder tops out near 12% and cannot reach 3:1 on these surfaces (see
 * `shared/theme/contrast.ts`), and the status washes the destructive rows use are
 * thinner still. Past roughly a third opacity the author has chosen a real fill that
 * can carry its own contrast, and sweeping it in here would only generate noise.
 */
const FAINT_FILL_MAX_ALPHA = 30;

function isFaintFill(token: string): boolean {
  const fill = token.slice(token.indexOf(":bg-") + 4);
  if (fill.startsWith("overlay-")) return true;
  const alpha = /\/(?:\[([\d.]+)%?\]|(\d+))$/.exec(fill);
  if (alpha === null) return false;
  return Number(alpha[1] ?? alpha[2]) <= FAINT_FILL_MAX_ALPHA;
}

type OutlineSlot = "width" | "style" | "ink" | "offset";

/** Which conflict group a `focus-visible:`-scoped outline utility settles. */
function classifyOutlineUtility(utility: string): { slot: OutlineSlot; value: string } | null {
  if (/^-?outline-offset-/.test(utility)) {
    return { slot: "offset", value: utility };
  }
  if (!utility.startsWith("outline-")) return null;
  const value = utility.slice("outline-".length);

  if (/^(solid|dashed|dotted|double|none|hidden)$/.test(value)) return { slot: "style", value };
  // A width is the numeric scale or an arbitrary length. `outline-2.5` is neither —
  // Tailwind emits no utility for it — so it must not prefix-match as `outline-2`.
  if (/^\d+$/.test(value)) return { slot: "width", value };
  if (/^\[[\d.]+px\]$/.test(value)) return { slot: "width", value };
  if (/^\[/.test(value)) return { slot: "ink", value };
  if (/^[\d.]/.test(value)) return null;
  return { slot: "ink", value };
}

/**
 * The outline each conflict group actually resolves to under `:focus-visible`, and
 * whether the element suppresses the outline style outside that variant.
 */
function resolveRing(expression: string): {
  slots: Partial<Record<OutlineSlot, string>>;
  suppressedOutsideVariant: boolean;
} {
  const slots: Partial<Record<OutlineSlot, string>> = {};
  let suppressedOutsideVariant = false;

  for (const raw of expression.split(/[\s"'`,()]+/)) {
    // Tailwind's important marker sits after the variant (`focus-visible:!outline-0`)
    // and changes nothing about which group a utility settles.
    const token = raw.replace(/!/g, "");
    if (token === "outline-hidden" || token === "outline-none") {
      suppressedOutsideVariant = true;
      continue;
    }
    if (!token.startsWith("focus-visible:")) continue;

    const classified = classifyOutlineUtility(token.slice("focus-visible:".length));
    if (classified === null) continue;
    slots[classified.slot] = classified.value;
  }

  return { slots, suppressedOutsideVariant };
}

const PAINTING_STYLES = new Set(["solid", "dashed", "dotted", "double"]);
const INVISIBLE_INKS = new Set(["transparent", "current", "inherit"]);

/**
 * Everything wrong with one highlighted row's focus treatment, in the order an author
 * would fix it. Empty means the row is fine.
 *
 * Returned rather than asserted so the self-tests can drive the same code the
 * repository scan runs — a detector proven only against itself proves nothing.
 */
function diagnoseHighlightRow(expression: string): string[] {
  const problems: string[] = [];
  const { slots, suppressedOutsideVariant } = resolveRing(expression);

  const widthPx =
    slots.width === undefined
      ? null
      : Number(slots.width.startsWith("[") ? slots.width.slice(1, -3) : slots.width);

  if (widthPx === null) {
    problems.push(
      "no outline-based keyboard ring — a `ring-*` box-shadow is stripped under forced-colors, and the fill alone is ~1.1:1"
    );
  } else if (widthPx < 2) {
    problems.push(
      `the ring resolves to ${widthPx}px; WCAG 2.2 SC 2.4.13 wants at least 2px, and a later utility can win this back`
    );
  }

  const ink = slots.ink;
  if (ink === undefined) {
    problems.push("the ring has no ink of its own, so it inherits `currentColor`");
  } else if (INVISIBLE_INKS.has(ink) || /\/(?:\[0*(?:\.0+)?%?\]|0+)$/.test(ink)) {
    problems.push(`the ring resolves to \`outline-${ink}\`, which paints nothing`);
  }

  const offset = slots.offset;
  if (widthPx !== null) {
    const magnitude =
      offset === undefined
        ? null
        : /^-outline-offset-/.test(offset)
          ? Number(offset.slice("-outline-offset-".length).replace(/[[\]]|px/g, ""))
          : -Number(offset.slice("outline-offset-".length).replace(/[[\]]|px/g, ""));
    if (magnitude === null || magnitude <= 0) {
      problems.push(
        "the ring needs a negative offset (`focus-visible:-outline-offset-2` or `focus-visible:outline-offset-[-2px]`) — these rows sit in an `overflow-y-auto` popup that clips an outward ring on the first and last item"
      );
    }
  }

  if (widthPx !== null && !PAINTING_STYLES.has(slots.style ?? "")) {
    problems.push(
      suppressedOutsideVariant
        ? "`outline-hidden` sets `--tw-outline-style: none` on this element and the width utility reads it back, so the ring paints nothing without `focus-visible:outline-solid`"
        : "the ring resolves to a non-painting outline style"
    );
  }

  return problems;
}

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

// The scans below are textual, so a comment that *names* `outline-hidden` — as the
// item primitives now do, explaining why the suppression is deliberate — reads as a
// bare occurrence with no fallback beside it. Blank comments out rather than asking
// authors not to write the word: documenting this pattern is the behaviour we want,
// and a rule that punishes it teaches the wrong lesson.
//
// A comment opener only counts when it OPENS A LINE, and a block is then blanked as
// a SPAN. Both halves are load-bearing, and each has a counterexample in the tree
// this scans:
//
//   - Mid-line `/*` is usually a glob inside a string (`"brands/*Icon.tsx"`,
//     `node_modules/**`). Honouring it opens a block that never closes and blanks
//     the rest of the file — a scanner that quietly deletes code stops finding the
//     violations it exists to find.
//   - Spans, not whole lines, because `/*@__PURE__*/ LanguageDescription.of({` in
//     `codeMirrorLanguages.ts` is an annotated call whose brace the helper-call
//     walker in `extractClassExpression` still has to see.
//   - A line-leading `*` is only JSDoc while a block is open. Outside one it is a
//     generator method — `*entries()` in `src/utils/ttlCache.ts`.
//
// Missing a trailing comment is the harmless direction: it costs a false positive
// an author can read, never a silently skipped violation.
//
// Replacement is space-for-space, so every match index and line number downstream
// still points at the original source.
function blankComments(source: string): string {
  const blank = (line: string, from: number, to: number): string =>
    line.slice(0, from) + " ".repeat(to - from) + line.slice(to);

  let inBlock = false;

  return source
    .split("\n")
    .map((line) => {
      if (inBlock) {
        const close = line.indexOf("*/");
        if (close === -1) return " ".repeat(line.length);
        inBlock = false;
        return blank(line, 0, close + 2);
      }

      const opensAt = line.length - line.trimStart().length;
      const opener = line.slice(opensAt, opensAt + 2);

      if (opener === "//") return " ".repeat(line.length);
      if (opener !== "/*") return line;

      const close = line.indexOf("*/", opensAt + 2);
      if (close === -1) {
        inBlock = true;
        return " ".repeat(line.length);
      }
      return blank(line, opensAt, close + 2);
    })
    .join("\n");
}

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
    file: "src/components/Worktree/ReviewHub/FileSection.tsx",
    fragment: "w-[104px] min-w-0 bg-transparent text-2xs",
    reason:
      "Section filter is a strip: the wrapper carries the border, focus-within and the forced-colors outline, so the bare input must not paint a second box inside it (that nested rectangle is exactly what #11984 removed)",
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
      const source = blankComments(fs.readFileSync(filePath, "utf8"));
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
      const source = blankComments(fs.readFileSync(filePath, "utf8"));
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

  describe("comment blanking", () => {
    it("hides a documented mention of the suppressor from the scan", () => {
      const source = [
        "/* `outline-hidden` is kept so forced-colors can recolour it. */",
        '<div className="p-2" />',
      ].join("\n");
      expect(/\boutline-hidden\b/.test(blankComments(source))).toBe(false);
    });

    it("keeps line numbers and match offsets intact", () => {
      const source = ["// leading note", '<div className="outline-hidden focus:ring-2" />'].join(
        "\n"
      );
      const blanked = blankComments(source);
      expect(blanked.length).toBe(source.length);
      expect(blanked.indexOf("outline-hidden")).toBe(source.indexOf("outline-hidden"));
      expect(blanked.split("\n")).toHaveLength(2);
    });

    it("blanks continuation lines of a block comment", () => {
      const source = ["/**", " * outline-hidden here is prose.", " */"].join("\n");
      expect(blankComments(source).trim()).toBe("");
    });

    // The three shapes in this tree that a whole-line or string-unaware rule would
    // eat. Each one deleted real code, and deleted code is a violation the scan can
    // no longer see.

    it("keeps a generator method whose line opens with an asterisk", () => {
      const source = ["class C {", "  *entries(): Iterable<string> {}", "}"].join("\n");
      expect(blankComments(source)).toBe(source);
    });

    it("keeps the call an inline annotation prefixes", () => {
      const source = '  /*@__PURE__*/ LanguageDescription.of({ name: "C" });';
      const blanked = blankComments(source);
      expect(blanked).toContain('LanguageDescription.of({ name: "C" });');
      expect(blanked).not.toContain("__PURE__");
      expect(blanked.length).toBe(source.length);
    });

    it("does not read a glob inside a string as a comment opener", () => {
      const source = [
        'const globs = ["brands/*Icon.tsx", "node_modules/**"];',
        '<div className="outline-hidden focus:ring-2" />',
      ].join("\n");
      expect(blankComments(source)).toBe(source);
    });
  });

  // ── Self-tests: highlight-fill quality detection ────────────────────
  //
  // Each detector has to fail loud on the shape it exists to reject. A detector that
  // silently matched everything would leave the scan below green while the rows it
  // guards lost their ring, so every case here is a rejection the scan depends on.

  describe("highlight-fill quality detection", () => {
    const FIXED =
      "text-xs outline-hidden transition-colors data-[highlighted]:bg-overlay-raised " +
      "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline " +
      "focus-visible:outline-offset-[-2px]";

    /** The scan's own verdict, so the self-tests exercise what production runs. */
    function problemsFor(expression: string): string[] {
      return diagnoseHighlightRow(expression);
    }

    it("passes a row that carries a real ring", () => {
      expect(problemsFor(FIXED)).toEqual([]);
    });

    it("rejects the fill-only row this issue was filed about", () => {
      const shipped =
        "text-xs outline-hidden transition-colors focus:bg-overlay-raised " +
        "data-[highlighted]:bg-overlay-raised";
      expect(problemsFor(shipped).length).toBeGreaterThan(0);
    });

    it("rejects a box-shadow ring, which forced-colors strips", () => {
      const ringed =
        "outline-hidden data-[highlighted]:bg-overlay-raised focus-visible:ring-2 " +
        "focus-visible:ring-daintree-accent/30";
      expect(problemsFor(ringed).length).toBeGreaterThan(0);
    });

    it("rejects a sub-2px ring", () => {
      expect(problemsFor(FIXED.replace("outline-2", "outline-1")).length).toBeGreaterThan(0);
    });

    it("rejects a ring with no ink of its own", () => {
      const inkless = FIXED.replace("focus-visible:outline-selection-outline ", "");
      expect(problemsFor(inkless).length).toBeGreaterThan(0);
    });

    it("rejects inks that paint nothing or inherit someone else's choice", () => {
      for (const ink of ["transparent", "current", "inherit"]) {
        const invisible = FIXED.replace("outline-selection-outline", `outline-${ink}`);
        expect(
          problemsFor(invisible).length,
          `outline-${ink} must not count as ink`
        ).toBeGreaterThan(0);
      }
    });

    it("rejects a positive or zero offset, in either spelling", () => {
      for (const offset of [
        "outline-offset-2",
        "outline-offset-[-0px]",
        "outline-offset-[-00px]",
        "-outline-offset-0",
      ]) {
        const outward = FIXED.replace("outline-offset-[-2px]", offset);
        expect(problemsFor(outward).length, `${offset} is not inset`).toBeGreaterThan(0);
      }
    });

    it("accepts both negative-offset spellings and fractional lengths", () => {
      for (const offset of [
        "focus-visible:-outline-offset-2",
        "focus-visible:outline-offset-[-2.5px]",
      ]) {
        const alt = FIXED.replace("focus-visible:outline-offset-[-2px]", offset);
        expect(problemsFor(alt), offset).toEqual([]);
      }
    });

    it("accepts arbitrary widths but not a scale value Tailwind never emits", () => {
      expect(problemsFor(FIXED.replace("outline-2", "outline-[2.5px]"))).toEqual([]);
      // `outline-2.5` compiles to nothing, so the row has no width at all — it must
      // not prefix-match the `outline-2` that would have been fine.
      expect(problemsFor(FIXED.replace("outline-2 ", "outline-2.5 ")).length).toBeGreaterThan(0);
    });

    // ── Last-wins: `cn()` resolves conflicts by order, so must this ──────
    //
    // Every case here passed a detector that merely asked whether a good token
    // appeared somewhere in the string. Each one is a row that renders wrong.

    it("takes the width a later utility wins, not the best one present", () => {
      expect(problemsFor(`${FIXED} focus-visible:outline-1`).length).toBeGreaterThan(0);
      expect(problemsFor(`${FIXED} focus-visible:outline-0`).length).toBeGreaterThan(0);
    });

    it("takes the ink a later utility wins", () => {
      expect(problemsFor(`${FIXED} focus-visible:outline-transparent`).length).toBeGreaterThan(0);
      expect(
        problemsFor(`${FIXED} focus-visible:outline-selection-outline/0`).length
      ).toBeGreaterThan(0);
    });

    it("takes the offset a later utility wins", () => {
      expect(problemsFor(`${FIXED} focus-visible:outline-offset-2`).length).toBeGreaterThan(0);
    });

    it("takes the style a later utility wins, important spelling included", () => {
      expect(problemsFor(`${FIXED} focus-visible:outline-none`).length).toBeGreaterThan(0);
      expect(problemsFor(`${FIXED} focus-visible:!outline-hidden`).length).toBeGreaterThan(0);
    });

    it("clears a row whose good tokens come last", () => {
      const recovered = `outline-hidden data-[highlighted]:bg-overlay-raised focus-visible:outline-0 focus-visible:outline-none ${FIXED.slice(FIXED.indexOf("focus-visible:"))}`;
      expect(problemsFor(recovered)).toEqual([]);
    });

    it("does not let another variant's style satisfy the focus-visible ring", () => {
      const wrongVariant = FIXED.replace("focus-visible:outline-solid", "hover:outline-solid");
      expect(problemsFor(wrongVariant).length).toBeGreaterThan(0);
    });

    it("sweeps in faint washes but leaves substantial fills alone", () => {
      for (const fill of [
        "data-[highlighted]:bg-overlay-raised",
        "data-[highlighted]:bg-status-danger/10",
        "data-[highlighted]:bg-status-danger/[10%]",
        "data-[highlighted]:bg-daintree-accent/30",
      ]) {
        expect(isFaintFill(fill), `${fill} is too faint to be an indicator`).toBe(true);
      }
      for (const fill of [
        "data-[highlighted]:bg-status-danger",
        "data-[highlighted]:bg-black/90",
      ]) {
        expect(isFaintFill(fill), `${fill} can carry its own contrast`).toBe(false);
      }
    });

    it("finds every faint-fill spelling in the source, bracketed alpha included", () => {
      const source = [
        'a="data-[highlighted]:bg-overlay-raised"',
        'b="data-[highlighted]:bg-status-danger/[10%]"',
        'c="data-[highlighted]:bg-black/90"',
      ].join("\n");
      const found = [...source.matchAll(new RegExp(HIGHLIGHT_FILL_PATTERN.source, "g"))]
        .map((m) => m[0])
        .filter(isFaintFill);
      expect(found).toEqual([
        "data-[highlighted]:bg-overlay-raised",
        "data-[highlighted]:bg-status-danger/[10%]",
      ]);
    });
  });

  /**
   * Quality, not presence.
   *
   * The repository scan above is satisfied by any non-suppressor `focus:` utility,
   * and a background tint is one. That is exactly how the menu primitives shipped
   * `focus:bg-overlay-raised` as their only focus signal and passed: `overlay-raised`
   * clears roughly 1.1:1 against the surfaces these rows float on, which
   * `shared/theme/contrast.ts` already treats as too little to be the WCAG 1.4.11
   * indicator (it is why the palette row grew a separate rail instead of a heavier
   * fill). A row highlighted with the overlay ladder therefore has to carry a real
   * keyboard ring beside the fill.
   *
   * `data-[highlighted]` is the marker because only Radix sets it, and Radix moves
   * DOM focus on `pointermove` as well as on arrow keys — so the fill is already the
   * pointer affordance, and what is missing is the keyboard-only one.
   */
  it("a low-contrast highlight fill is never a row's only focus indicator", () => {
    const scanRoots = [SRC_ROOT, ...PLUGIN_RENDERER_ROOTS];
    const allFiles = scanRoots.flatMap((root) =>
      fs.existsSync(root) ? collectSourceFiles(root) : []
    );
    expect(allFiles.length, "scan must find source files").toBeGreaterThan(100);

    const violations: Array<{ file: string; line: number; problem: string }> = [];
    const seenFiles = new Set<string>();

    for (const filePath of allFiles) {
      const source = blankComments(fs.readFileSync(filePath, "utf8"));
      const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");

      HIGHLIGHT_FILL_PATTERN.lastIndex = 0;
      for (const match of source.matchAll(HIGHLIGHT_FILL_PATTERN)) {
        const matchPos = match.index ?? -1;
        if (matchPos < 0) continue;

        if (!isFaintFill(match[0])) continue;

        seenFiles.add(relativePath);
        const expression = extractClassExpression(source, matchPos);
        const lineNumber = source.slice(0, matchPos).split("\n").length;

        for (const problem of diagnoseHighlightRow(expression)) {
          violations.push({ file: relativePath, line: lineNumber, problem });
        }
      }
    }

    // Non-vacuity by name, not by count. The three shared primitives are where this
    // pattern lives and where everything downstream copies it from, so a scan that
    // stops reaching them has broken rather than passed. A bare total would instead
    // pin today's duplication and fail the next honest refactor.
    for (const sentinel of [
      "src/components/ui/dropdown-menu.tsx",
      "src/components/ui/context-menu.tsx",
      "src/components/ui/select.tsx",
    ]) {
      expect(seenFiles.has(sentinel), `scan must still reach ${sentinel}`).toBe(true);
    }

    if (violations.length === 0) return;

    const detail = violations.map((v) => `  ${v.file}:${v.line} — ${v.problem}`).join("\n");
    throw new Error(
      `Found ${violations.length} row(s) whose \`data-[highlighted]\` fill is doing work it ` +
        `cannot do. The fill is the pointer affordance; keyboard focus needs its own indicator ` +
        `(\`focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline ` +
        `focus-visible:outline-offset-[-2px]\`):\n${detail}`
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
