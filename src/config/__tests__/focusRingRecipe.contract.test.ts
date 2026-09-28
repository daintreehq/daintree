import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SCAN_ROOTS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "plugins/builtin/github/renderer"),
  path.join(REPO_ROOT, "plugins/builtin/markdown-editor/renderer"),
];

// Keyboard focus looks the same everywhere: one mechanism (outline), one width
// (2px), one ink (accent, with the documented neutral and status exceptions) and
// two offsets — +2 outside, -2 inside a scroller or a packed group. See "The
// focus ring" in docs/themes/component-contract.md and the focus recipes in
// docs/themes/interaction-state-recipes.md.
//
// `focusRingFallback.contract.test.ts` asks whether an element HAS a ring. This
// asks whether the ring it has is the app's ring.

type Rule = "mechanism" | "width" | "offset" | "ink";

interface Violation {
  rule: Rule;
  token: string;
}

// A `ring-*` box-shadow is forced to `none` under forced-colors and paints at a
// different weight from the outline every other control wears.
const RING_FOCUS = /(?<![\w-])focus(?:-visible|-within)?:ring-(?!0\b|offset-)[\w[\]/.%-]+/g;
const OUTLINE_FOCUS = /(?<![\w-])focus-visible:!?(-?outline-[\w[\]().,%/-]+)/g;

const CANONICAL_OFFSETS = new Set([
  "outline-offset-2",
  "-outline-offset-2",
  "outline-offset-[2px]",
  "outline-offset-[-2px]",
]);

// `selection-outline` is the Radix-row and search-field ink (see "Radix row
// exception" in the recipes); the status inks mark destructive controls.
const ALLOWED_INKS = new Set([
  "accent-primary",
  "selection-outline",
  "status-error",
  "status-warning",
]);

// `transparent` is how a control hands its ring to an enclosing row (RadioChoice,
// the pilot park editor): it keeps a paintable outline for forced-colors to
// recolour without drawing one of its own.
const NON_INK_VALUES =
  /^(hidden|solid|dashed|dotted|double|none|transparent|\d+|\[\d+(\.\d+)?px\])$/;

function diagnoseFocusRing(expression: string): Violation[] {
  const violations: Violation[] = [];

  for (const match of expression.matchAll(RING_FOCUS)) {
    violations.push({ rule: "mechanism", token: match[0] });
  }

  for (const match of expression.matchAll(OUTLINE_FOCUS)) {
    const utility = match[1] ?? "";
    if (/^-?outline-offset-/.test(utility)) {
      if (!CANONICAL_OFFSETS.has(utility)) violations.push({ rule: "offset", token: match[0] });
      continue;
    }
    const value = utility.slice("outline-".length);
    if (/^\d+$/.test(value) || /^\[[\d.]+px\]$/.test(value)) {
      const px = Number(value.replace(/[[\]px]/g, ""));
      if (px !== 2) violations.push({ rule: "width", token: match[0] });
      continue;
    }
    if (NON_INK_VALUES.test(value)) continue;
    if (!ALLOWED_INKS.has(value)) violations.push({ rule: "ink", token: match[0] });
  }

  return violations;
}

interface AllowlistEntry {
  file: string;
  rule: Rule;
  /** How many lines of this file may break this rule — never the whole file. */
  lines: number;
  reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
  {
    file: "src/components/Terminal/composerControlStyles.ts",
    rule: "ink",
    lines: 1,
    reason:
      "composer controls repeat in every composer and the shell's own focus edge spends the accent, so their ring is a neutral mix of the terminal's own ink",
  },
  {
    file: "src/components/Terminal/HybridInputBar.tsx",
    rule: "mechanism",
    lines: 1,
    reason:
      "the composer shell's focus-within edge is a field boundary, not a control ring; the field family owns it",
  },
  {
    file: "src/components/Setup/AgentSetupWizard.tsx",
    rule: "offset",
    lines: 1,
    reason: "a focusable step heading, ringed clear of its text on purpose (offset-4)",
  },
  {
    file: "src/components/Terminal/TerminalInfoDialog.tsx",
    rule: "offset",
    lines: 1,
    reason: "a focusable dialog heading, ringed clear of its text on purpose (offset-4)",
  },
  // Owned by sibling consistency passes that convert these sites themselves.
  {
    file: "src/components/DevPreview/ConsoleDrawer.tsx",
    rule: "mechanism",
    lines: 2,
    reason: "Dev Preview console — converted with the Dev Preview / Diagnostics pass",
  },
  {
    file: "src/components/DevPreview/ConsolePanel.tsx",
    rule: "mechanism",
    lines: 1,
    reason: "Dev Preview console — converted with the Dev Preview / Diagnostics pass",
  },
  {
    file: "src/components/DevPreview/DiagnosticsPanel.tsx",
    rule: "mechanism",
    lines: 1,
    reason: "Dev Preview diagnostics — converted with the Dev Preview / Diagnostics pass",
  },
  {
    file: "src/components/Diagnostics/DiagnosticsDock.tsx",
    rule: "mechanism",
    lines: 1,
    reason: "Diagnostics dock tabs — converted with the Dev Preview / Diagnostics pass",
  },
  {
    file: "src/components/HelpPanel/HelpSessionTabs.tsx",
    rule: "offset",
    lines: 2,
    reason: "assistant session tabs — converted with the document tab strip pass",
  },
];

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "__preview__", "node_modules"].includes(entry.name)) continue;
      result.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(test|spec)\./.test(entry.name)) continue;
    result.push(fullPath);
  }
  return result;
}

function isCommentLine(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

describe("focus ring recipe contract", () => {
  describe("the detector", () => {
    const CANONICAL =
      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2";

    it("passes the canonical ring, outside and inset", () => {
      expect(diagnoseFocusRing(CANONICAL)).toEqual([]);
      expect(diagnoseFocusRing(CANONICAL.replace("outline-offset-2", "-outline-offset-2"))).toEqual(
        []
      );
      expect(
        diagnoseFocusRing(CANONICAL.replace("outline-offset-2", "outline-offset-[-2px]"))
      ).toEqual([]);
    });

    it("passes the documented inks and the suppress-then-restore spelling", () => {
      expect(
        diagnoseFocusRing(
          "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:-outline-offset-2"
        )
      ).toEqual([]);
      expect(diagnoseFocusRing(CANONICAL.replace("accent-primary", "status-error"))).toEqual([]);
    });

    it("flags a box-shadow ring on any focus variant", () => {
      for (const ring of [
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary",
        "focus:ring-1 focus:ring-status-error",
        "focus-within:ring-1 focus-within:ring-border-strong",
      ]) {
        expect(diagnoseFocusRing(ring).map((v) => v.rule)).toContain("mechanism");
      }
    });

    it("ignores ring-0 and ring-offset, which draw nothing of their own", () => {
      expect(diagnoseFocusRing(`${CANONICAL} focus-visible:ring-0`)).toEqual([]);
    });

    it("flags a width other than 2px", () => {
      expect(
        diagnoseFocusRing(CANONICAL.replace("outline-2", "outline-1")).map((v) => v.rule)
      ).toEqual(["width"]);
      expect(
        diagnoseFocusRing(CANONICAL.replace("outline-2", "outline-[1px]")).map((v) => v.rule)
      ).toEqual(["width"]);
    });

    it("flags an offset other than +2 or -2", () => {
      for (const offset of [
        "outline-offset-1",
        "-outline-offset-1",
        "outline-offset-0",
        "outline-offset-[-1px]",
      ]) {
        expect(
          diagnoseFocusRing(CANONICAL.replace("outline-offset-2", offset)).map((v) => v.rule)
        ).toEqual(["offset"]);
      }
    });

    it("flags an ink outside the focus vocabulary", () => {
      for (const ink of ["text-secondary", "border-strong", "ring", "daintree-accent"]) {
        expect(
          diagnoseFocusRing(CANONICAL.replace("accent-primary", ink)).map((v) => v.rule)
        ).toEqual(["ink"]);
      }
    });
  });

  it("every keyboard focus ring in the renderer is the app's ring", () => {
    const offenders: string[] = [];
    const allowanceUse = new Map<AllowlistEntry, number>();

    for (const root of SCAN_ROOTS) {
      for (const file of collectSourceFiles(root)) {
        const rel = path.relative(REPO_ROOT, file);
        const lines = fs.readFileSync(file, "utf8").split("\n");
        lines.forEach((text, idx) => {
          if (isCommentLine(text)) return;
          const byRule = new Map<Rule, string[]>();
          for (const violation of diagnoseFocusRing(text)) {
            byRule.set(violation.rule, [...(byRule.get(violation.rule) ?? []), violation.token]);
          }
          for (const [rule, tokens] of byRule) {
            const allowance = ALLOWLIST.find((e) => e.file === rel && e.rule === rule);
            if (allowance) {
              const used = (allowanceUse.get(allowance) ?? 0) + 1;
              allowanceUse.set(allowance, used);
              if (used <= allowance.lines) continue;
            }
            offenders.push(`  ${rel}:${idx + 1} — ${rule}: ${tokens.join(" ")}`);
          }
        });
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `Found ${offenders.length} focus ring(s) off the recipe. Use ` +
          "`focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary " +
          "focus-visible:outline-offset-2` (or `focus-visible:-outline-offset-2` inside a " +
          `scroller or packed group):\n${offenders.join("\n")}`
      );
    }
    expect(offenders).toEqual([]);
  });
});
