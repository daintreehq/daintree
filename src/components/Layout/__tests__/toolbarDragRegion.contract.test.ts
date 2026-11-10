import { describe, expect, it } from "vitest";
import { readToolbarCss } from "@/__tests__/support/cssManifest";

// The toolbar strip is `app-drag-region`, and its pseudo-elements inherit that
// `drag`. Chromium builds the window's drag region in document order, drag rects
// added and no-drag rects cut out, so a strip `::before` comes ahead of the
// controls and their cut-outs win, but a strip `::after` comes after them and
// puts the drag back over whatever it covers. The remote window's occluder is
// one, drawn exactly under the project pill: on macOS the pill's clicks became
// title-bar presses and the project switcher never opened in a remote window.
//
// jsdom resolves no `app-region`, so this pins the declaration, not the
// browser's region.

const STRIPPED = readToolbarCss().replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));

interface Rule {
  selectors: string[];
  body: string;
}

const RULES: Rule[] = Array.from(STRIPPED.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({
  selectors: m[1]!
    .trim()
    .split(",")
    .map((s) => s.trim().replace(/\s+/g, " ")),
  body: m[2]!,
}));

function decl(body: string, prop: string): string | undefined {
  const m = new RegExp(`(?:^|;|\\s)${prop.replace(/-/g, "\\-")}\\s*:\\s*([^;]+);`).exec(body);
  return m?.[1]?.trim().replace(/\s*!important$/, "");
}

/** An `::after` on the strip itself, not on a control inside it. */
const STRIP_AFTER = /^\.surface-toolbar(?:\[[^\]]+\])*::after$/;

const stripAfterRules = RULES.filter(
  (rule) => rule.selectors.some((s) => STRIP_AFTER.test(s)) && decl(rule.body, "position")
);

describe("toolbar strip pseudo-elements and the window drag region", () => {
  it("finds the remote window's pill occluder", () => {
    expect(
      stripAfterRules.some((rule) =>
        rule.selectors.includes(".surface-toolbar[data-remote-window]::after")
      )
    ).toBe(true);
  });

  it.each(stripAfterRules.map((rule) => [rule.selectors.join(", "), rule] as const))(
    "%s claims no drag over the controls it sits under",
    (_name, rule) => {
      expect(decl(rule.body, "app-region")).toBe("no-drag");
      expect(decl(rule.body, "-webkit-app-region")).toBe("no-drag");
    }
  );
});
