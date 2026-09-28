import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { COUNT_BADGE_CLASS } from "../badge";
import { PALETTE_SECTION_LABEL_CLASS } from "../paletteRowStyles";
import { LIST_LABEL_CLASS, SECTION_LABEL_CLASS } from "../sectionLabel";
import { HEADER_CHIP_CLASS } from "@/components/Terminal/terminalHeaderChip";

const ROOT = path.resolve(__dirname, "../../../..");
const SRC = path.join(ROOT, "src");

const tokens = (s: string) => s.split(/\s+/).filter(Boolean);
const FONT_SIZE = /^text-(4xs|3xs|2xs|xs|sm|base|lg)$/;
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" || name === "__preview__" ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

function stringLiterals(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      out.push([node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" "));
    } else if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      out.push(node.initializer.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const FILES = sourceFiles(SRC).map((file) => ({ file: rel(file), literals: stringLiterals(file) }));

function offenders(match: (t: string[]) => boolean, owners: string[]): Record<string, number> {
  const found: Record<string, number> = {};
  for (const { file, literals } of FILES) {
    if (owners.includes(file)) continue;
    const n = literals.filter((s) => match(tokens(s))).length;
    if (n > 0) found[file] = n;
  }
  return found;
}

/** A hand-spelled uppercase micro-label: sized, tracked and uppercased in one string. */
const isMicroLabel = (t: string[]) =>
  t.includes("uppercase") &&
  t.some((x) => FONT_SIZE.test(x)) &&
  t.some((x) => /^tracking-/.test(x));

/**
 * Uppercase strings that are not section labels, each for a reason the label
 * family does not share. A file that drops its reason drops off this list.
 */
const MICRO_LABEL_EXCEPTIONS: Record<string, number> = {
  // Git's own vocabulary inside rebase and conflict rows ("pick", "both
  // modified"), drawn mono like the todo list it mirrors — a row tag, not a heading.
  "src/components/Worktree/ReviewHub/ConflictPanel.tsx": 2,
  // The "N background" status floated over a maximized pane's header.
  "src/components/Panel/PanelHeader.tsx": 1,
  // The review row's "Viewed" checkbox label — a control, owned by the checkbox family.
  "src/components/Worktree/ReviewHub/FileStageRow.tsx": 1,
  // The drawer's tab strip, owned by the dev-preview drawer family.
  "src/components/DevPreview/ConsoleDrawer.tsx": 1,
};

/** A hand-rolled count pill: round, tabular and tiny in one string. */
const isCountPill = (t: string[]) =>
  t.includes("rounded-full") && t.includes("tabular-nums") && t.includes("text-3xs");

describe("section label family", () => {
  it("has exactly two recipes, both readable and both uppercase", () => {
    for (const recipe of [SECTION_LABEL_CLASS, LIST_LABEL_CLASS]) {
      const t = tokens(recipe);
      expect(t).toContain("uppercase");
      expect(t).toContain("text-text-secondary");
      expect(t.filter((x) => FONT_SIZE.test(x))).toHaveLength(1);
      expect(recipe).not.toMatch(/text-muted|text-text-muted|\/\d/);
    }
    // One step apart, so a list band never reads as a section heading.
    expect(tokens(SECTION_LABEL_CLASS).find((x) => FONT_SIZE.test(x))).not.toBe(
      tokens(LIST_LABEL_CLASS).find((x) => FONT_SIZE.test(x))
    );
  });

  it("gives palettes the list recipe rather than a copy of it", () => {
    expect(PALETTE_SECTION_LABEL_CLASS).toBe(LIST_LABEL_CLASS);
  });

  it("is never spelled out by hand outside the shared module", () => {
    expect(offenders(isMicroLabel, ["src/components/ui/sectionLabel.ts"])).toEqual(
      MICRO_LABEL_EXCEPTIONS
    );
  });
});

describe("count badge family", () => {
  it("is round and tabular, and keeps an edge under forced colors", () => {
    const t = tokens(COUNT_BADGE_CLASS);
    expect(t).toContain("rounded-full");
    expect(t).toContain("tabular-nums");
    expect(t).toContain("normal-case");
    expect(t.some((x) => x.startsWith("forced-colors:border"))).toBe(true);
  });

  it("is never hand-rolled outside the badge module", () => {
    expect(offenders(isCountPill, ["src/components/ui/badge.tsx"])).toEqual({});
  });
});

describe("pane header chip row", () => {
  const ROW = [
    "src/components/Terminal/TerminalHeaderContent.tsx",
    "src/components/Terminal/TerminalRateLimitBadge.tsx",
    "src/components/Terminal/TerminalHandOver.tsx",
    "src/components/Terminal/TerminalNotifyChip.tsx",
    "src/components/Terminal/SubagentChip.tsx",
    "src/components/Panel/PluginPanelBadges.tsx",
    "src/components/Panel/PanelHeader.tsx",
  ];

  it("draws every chip in one box: one type size, one shape", () => {
    const t = tokens(HEADER_CHIP_CLASS);
    expect(t.filter((x) => FONT_SIZE.test(x))).toHaveLength(1);
    expect(t).toContain("rounded-full");
  });

  it("never sizes a pill of its own", () => {
    for (const file of ROW) {
      const own = FILES.find((f) => f.file === file)!.literals.filter((s) => {
        const t = tokens(s);
        return t.includes("rounded-full") && t.some((x) => /^px-/.test(x));
      });
      expect(own, file).toEqual([]);
    }
  });
});
