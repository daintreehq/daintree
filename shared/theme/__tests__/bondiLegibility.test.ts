import { describe, expect, it } from "vitest";
import {
  BUILT_IN_APP_SCHEMES,
  blendOverBackground,
  contrastRatio,
  deltaEOK,
  parseRgba,
} from "../index.js";
import type { AppThemeTokenKey } from "../index.js";

/**
 * Bondi is the default light theme, and each of these rules was once broken in
 * a way the shared contrast gate could not see: a colour that clears its budget
 * on the bare surface but not on the surface it actually paints on. They assert
 * the rule, never the hex — any value that keeps the rule passes.
 */
const bondi = BUILT_IN_APP_SCHEMES.find((s) => s.id === "bondi")!;
const token = (key: AppThemeTokenKey) => bondi.tokens[key];

/** Composite an rgba() or solid token over a background. */
function paint(value: string, bg: string): string {
  const alpha = parseRgba(value);
  return alpha ? blendOverBackground(alpha.hex, bg, alpha.opacity) : value;
}

const SYNTAX_ROLES = [
  "syntax-comment",
  "syntax-punctuation",
  "syntax-number",
  "syntax-string",
  "syntax-operator",
  "syntax-keyword",
  "syntax-function",
  "syntax-link",
  "syntax-quote",
  "text-primary",
] as const satisfies readonly AppThemeTokenKey[];

describe("bondi", () => {
  it("is a built-in scheme", () => {
    expect(bondi).toBeDefined();
  });

  // DiffViewer.css paints the word-level edit span inside a line cell that
  // already carries the line wash, so an alpha edit wash stacks on the line
  // wash. The changed characters are the ones a review is about; they must be
  // at least as legible as the code around them.
  it.each([
    ["insert", "diff-insert-background", "diff-insert-edit-background"],
    ["delete", "diff-delete-background", "diff-delete-edit-background"],
  ] as const)("keeps every syntax role at AA on the %s line and word washes", (_, line, edit) => {
    const canvas = token("surface-canvas");
    const lineBg = paint(token(line), canvas);
    const editBg = paint(token(edit), lineBg);
    for (const bg of [lineBg, editBg]) {
      for (const role of SYNTAX_ROLES) {
        const ratio = contrastRatio(token(role), bg);
        expect(
          ratio,
          `${role} ${token(role)} on ${bg} is ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  // Status colours print as text (`+123` counts, the file-tree `M`, error
  // rows) on the sidebar, and as labels on their own 10-15% tint.
  it.each(["status-success", "status-warning", "status-danger", "status-info"] as const)(
    "prints %s at AA on the sidebar and on its own chip tint",
    (key) => {
      const ink = token(key);
      const backgrounds = {
        sidebar: token("surface-sidebar"),
        "15% over panel": blendOverBackground(ink, token("surface-panel"), 0.15),
        "10% over white": blendOverBackground(ink, token("surface-panel-elevated"), 0.1),
      };
      for (const [where, bg] of Object.entries(backgrounds)) {
        const ratio = contrastRatio(ink, bg);
        expect(ratio, `${key} ${ink} on ${where} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          4.5
        );
      }
    }
  );

  // The waiting ring is a thin stroke, so luminance contrast is what makes it
  // the loudest mark on a light field — and it must not read as the warning
  // colour a shade darker.
  it("makes waiting the heaviest status mark and keeps it apart from warning", () => {
    const white = token("surface-panel-elevated");
    const waiting = contrastRatio(token("activity-waiting"), white);
    for (const key of [
      "status-success",
      "status-warning",
      "status-danger",
      "status-info",
    ] as const) {
      expect(waiting, `waiting must out-weigh ${key}`).toBeGreaterThan(
        contrastRatio(token(key), white)
      );
    }
    expect(deltaEOK(token("activity-waiting"), token("status-warning"))).toBeGreaterThanOrEqual(
      0.04
    );
  });

  // ANSI 90 carries hints, timestamps and secondary CLI output: body text.
  it("keeps the terminal dim slot at AA and every base ANSI colour at AA", () => {
    const bg = token("terminal-background");
    for (const key of [
      "terminal-bright-black",
      "terminal-red",
      "terminal-green",
      "terminal-yellow",
      "terminal-blue",
      "terminal-magenta",
      "terminal-cyan",
    ] as const) {
      const ratio = contrastRatio(token(key), bg);
      expect(ratio, `${key} ${token(key)} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // `#panel-grid` paints this extension as background-color, where a gradient
  // is invalid and the gutter silently falls through to the canvas.
  it("gives the panel gutter a plain colour and keeps it below the panels", () => {
    const gutter = bondi.extensions?.["panel-grid-bg"];
    expect(gutter).toMatch(/^#[0-9a-f]{6}$/i);
    // Below the panels by a step a large field reads as a frame; the pane
    // border and ambient shadow carry the edge itself.
    expect(contrastRatio(gutter!, token("surface-panel"))).toBeGreaterThanOrEqual(1.1);
  });
});
