import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * The row shape of the two list families (docs/themes/interaction-state-recipes.md,
 * "Highlighted Row" → "Row shape"). A full-screen palette row is `radius-md`
 * with a `px-3` inset and no resting fill; a popover picker row matches the menu
 * row it sits beside, `radius-sm` with `px-2 py-1.5`. The highlight is shared
 * (`PALETTE_ROW_CLASS`), but the box is written at each site, so this scans the
 * sites for the ways they drift: a card-sized radius, a resting backplate or
 * border colour, and a row borrowing the other family's box.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const ROOTS = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "plugins/builtin")];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx|ts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

interface RowCall {
  /** Every class token in the call's string literals, whichever branch they sit on. */
  classes: string[];
  /** Which shared class the call composes. */
  kind: "row" | "focus";
  line: number;
}

/**
 * Every `cn(...)` call that composes `PALETTE_ROW_CLASS` (a cursor row) or
 * `PALETTE_ROW_FOCUS_CLASS` (a row outside the cursor listbox that holds real
 * focus). Read from the syntax tree, so comments and quote style cannot hide a
 * class or end a call early.
 */
function rowCalls(source: string, fileName = "fixture.tsx"): RowCall[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const calls: RowCall[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "cn"
    ) {
      const names = new Set<string>();
      const classes: string[] = [];
      const collect = (n: ts.Node) => {
        if (ts.isIdentifier(n)) names.add(n.text);
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
          classes.push(...n.text.split(/\s+/).filter(Boolean));
        }
        ts.forEachChild(n, collect);
      };
      node.arguments.forEach(collect);
      const kind = names.has("PALETTE_ROW_CLASS")
        ? "row"
        : names.has("PALETTE_ROW_FOCUS_CLASS")
          ? "focus"
          : null;
      if (kind) {
        const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        calls.push({ classes, kind, line });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

const CARD_RADIUS = /^rounded-(lg|xl|2xl|3xl|\[var\(--radius-(lg|xl|2xl|3xl)\)\])$/;
/** Width and side only — `border`, `border-x`, `border-t-2`, `border-transparent`. */
const BORDER_WITHOUT_COLOUR = /^border(-[xytblrse])?(-(\d+|transparent))?$/;

/**
 * A bare `bg-*` paints every row at rest; variant-prefixed fills (`hover:`,
 * `aria-selected:`) are state, not a backplate. A border colour lights a row the
 * highlight does not own, so a second row reads as selected beside the real one.
 */
function restingViolations(call: RowCall): string[] {
  return call.classes.filter(
    (t) =>
      CARD_RADIUS.test(t) ||
      /^bg-/.test(t) ||
      (/^border(-|$)/.test(t) && !BORDER_WITHOUT_COLOUR.test(t))
  );
}

type Family = "palette" | "popover";

const FAMILY_BOX: Record<Family, { radius: string; inset: string; heights: string[] }> = {
  palette: { radius: "rounded-[var(--radius-md)]", inset: "px-3", heights: ["py-1.5", "py-2"] },
  popover: { radius: "rounded-[var(--radius-sm)]", inset: "px-2", heights: ["py-1.5"] },
};

/**
 * The project switcher's scratch browse rows, their inline rename editor and
 * the create button are denser than its ranked rows on purpose: they are a
 * secondary band under the project list. Documented in the recipe.
 */
const DENSE_ROW_FILES = new Set(["src/components/Project/ProjectSwitcherPalette.tsx"]);

function boxViolations(rel: string, source: string, family: Family): string[] {
  const box = FAMILY_BOX[family];
  const heights = DENSE_ROW_FILES.has(rel) ? [...box.heights, "py-1"] : box.heights;
  const out: string[] = [];
  for (const call of rowCalls(source, rel)) {
    // A focusable non-row control (a band label, a full-bleed command row)
    // draws no rounded box, so it is not a row of this family.
    if (call.kind === "focus" && !call.classes.some((t) => t.startsWith("rounded"))) continue;
    const missing = [box.radius, box.inset].filter((t) => !call.classes.includes(t));
    if (!call.classes.some((t) => heights.includes(t))) missing.push(heights.join(" | "));
    if (missing.length) out.push(`${rel}:${call.line} missing ${missing.join(", ")}`);
  }
  return out;
}

/** Popover pickers: an anchored dropdown whose rows sit beside menu rows. */
const POPOVER_FILES = [
  "src/components/Worktree/views/BranchPickerPanel.tsx",
  "src/components/Worktree/views/AgentPickerPopover.tsx",
  "src/components/Worktree/views/RecipePickerPopover.tsx",
  "src/components/Worktree/views/NewBranchInput.tsx",
  "src/components/Settings/SettingsSubjectPicker.tsx",
  "src/components/Settings/PresetSelector.tsx",
  "src/components/Settings/EnvVarEditor.tsx",
  "src/components/Panel/MoveToWorktreePicker.tsx",
  "src/components/Layout/DockLaunchButton.tsx",
  "src/components/Project/ProjectSwitcherPalette.tsx",
];

/** Full-screen palettes: the `AppPaletteDialog` / `SearchablePalette` shell. */
const PALETTE_FILES = [
  "src/components/Worktree/WorktreePalette.tsx",
  "src/components/Worktree/QuickCreatePalette.tsx",
  "src/components/ActionPalette/ActionPaletteItem.tsx",
  "src/components/QuickSwitcher/QuickSwitcherItem.tsx",
  "src/components/ThemePalette/ThemePalette.tsx",
  "src/components/TerminalPalette/NewTerminalPalette.tsx",
  "src/components/LogLevelPalette/LogLevelPalette.tsx",
  "src/components/PanelPalette/PanelPalette.tsx",
  "src/components/Terminal/PromptHistoryPalette.tsx",
  "src/components/Terminal/ResumeSessionsPalette.tsx",
  "src/components/Terminal/SendToAgentPalette.tsx",
  "src/components/Worktree/IssuePickerDialog.tsx",
  "src/components/Plugin/PluginQuickPickDialog.tsx",
];

const files = ROOTS.flatMap(sourceFiles).map((file) => ({
  rel: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
  source: fs.readFileSync(file, "utf8"),
}));

function read(rel: string): string {
  const file = files.find((f) => f.rel === rel);
  expect(file, `${rel} is listed but no longer exists — update the family list`).toBeDefined();
  return file!.source;
}

const row = (classes: string) => `const c = cn(PALETTE_ROW_CLASS, ${classes});`;

describe("palette and picker row shape — the checks catch what they claim to", () => {
  it.each([
    ["a border colour", row('"px-3 py-2 rounded-[var(--radius-md)] border-text-primary"')],
    [
      "a single-quoted resting fill",
      row("'px-3 py-2 rounded-[var(--radius-md)] bg-surface-canvas'"),
    ],
    ["a card radius behind a comment that closes a paren", row('/* ) */ "px-3 py-2 rounded-lg"')],
    [
      "a card radius on a conditional branch",
      row('"px-3 py-2", open ? "rounded-xl" : "rounded-[var(--radius-md)]"'),
    ],
  ])("flags %s", (_label, source) => {
    const calls = rowCalls(source);
    expect(calls).toHaveLength(1);
    expect(restingViolations(calls[0]!)).not.toEqual([]);
  });

  it("allows border width, side and transparency, and state-prefixed fills", () => {
    const [call] = rowCalls(
      row(
        '"border border-x border-t-2 border-transparent hover:bg-overlay-subtle rounded-[var(--radius-md)]"'
      )
    );
    expect(restingViolations(call!)).toEqual([]);
  });

  it.each([
    ["a missing radius", "popover", row('"px-2 py-1.5"')],
    ["an oversized height", "popover", row('"px-2 py-20 rounded-[var(--radius-sm)]"')],
    ["the palette box in a popover", "popover", row('"px-3 py-2 rounded-[var(--radius-md)]"')],
    ["the popover box in a palette", "palette", row('"px-2 py-1.5 rounded-[var(--radius-sm)]"')],
    [
      "a focusable popover row at the palette radius",
      "popover",
      'const c = cn("px-2 py-1.5 rounded-[var(--radius-md)]", PALETTE_ROW_FOCUS_CLASS);',
    ],
  ] as const)("flags %s", (_label, family, source) => {
    expect(boxViolations("fixture.tsx", source, family)).not.toEqual([]);
  });
});

describe("palette and picker row shape", () => {
  it("never gives a highlighted-row list a card radius, a resting fill or a border colour", () => {
    const offenders: string[] = [];
    for (const { rel, source } of files) {
      for (const call of rowCalls(source, rel)) {
        if (call.kind !== "row") continue;
        const bad = restingViolations(call);
        if (bad.length) offenders.push(`${rel}:${call.line}: ${bad.join(", ")}`);
      }
    }
    expect(
      offenders,
      "Rows in a list are lit by the one highlight, not framed as stacked cards"
    ).toEqual([]);
  });

  it("rules the palettes' dividers with the divider token, not an alpha of a raw colour", () => {
    const offenders = [
      ...PALETTE_FILES,
      ...POPOVER_FILES,
      "src/components/ui/PaletteOverflowNotice.tsx",
    ]
      .map((rel) => ({
        rel,
        hits: read(rel).match(/border-(daintree-border\/\d+|\[var\([^)]*\)\])/g),
      }))
      .filter(({ hits }) => hits)
      .map(({ rel, hits }) => `${rel}: ${hits!.join(", ")}`);
    expect(offenders).toEqual([]);
  });

  it.each(PALETTE_FILES)(
    "draws full-palette rows in %s at radius-md, px-3, py-1.5 or py-2",
    (rel) => {
      const source = read(rel);
      expect(
        rowCalls(source, rel).filter((c) => c.kind === "row").length,
        `${rel} should compose PALETTE_ROW_CLASS`
      ).toBeGreaterThan(0);
      expect(boxViolations(rel, source, "palette")).toEqual([]);
    }
  );

  it.each(POPOVER_FILES)(
    "draws popover rows in %s at radius-sm, px-2 py-1.5, like a menu row",
    (rel) => {
      const source = read(rel);
      expect(
        rowCalls(source, rel).filter((c) => c.kind === "row").length,
        `${rel} should compose PALETTE_ROW_CLASS`
      ).toBeGreaterThan(0);
      expect(boxViolations(rel, source, "popover")).toEqual([]);
    }
  );
});
