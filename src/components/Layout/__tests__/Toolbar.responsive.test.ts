import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");
const TOOLBAR_CSS_PATH = path.resolve(__dirname, "../../../styles/components/toolbar.css");

describe("Toolbar responsive design — issue #4133", () => {
  let source: string;
  let css: string;

  beforeEach(async () => {
    [source, css] = await Promise.all([
      fs.readFile(TOOLBAR_PATH, "utf-8"),
      fs.readFile(TOOLBAR_CSS_PATH, "utf-8"),
    ]);
  });

  describe("overflow hook integration", () => {
    it("imports useToolbarOverflow hook", () => {
      expect(source).toContain("useToolbarOverflow");
    });

    it("renders data-toolbar-button-id measurement wrappers", () => {
      expect(source).toContain("data-toolbar-button-id={");
    });

    it("has left and right group refs for overflow measurement", () => {
      expect(source).toContain("leftGroupRef");
      expect(source).toContain("rightGroupRef");
    });

    it("renders overflow menu with Ellipsis icon", () => {
      expect(source).toContain("Ellipsis");
      expect(source).toContain("renderOverflowMenu");
    });

    it("uses DropdownMenu for overflow menus", () => {
      expect(source).toContain("DropdownMenu");
      expect(source).toContain("DropdownMenuContent");
      expect(source).toContain("DropdownMenuItem");
    });
  });

  describe("branch chip responsive collapse", () => {
    it("branch chip has GitBranch icon", () => {
      expect(source).toContain("GitBranch");
      expect(source).toContain("toolbar-project-chip-icon");
    });

    it("branch chip text has label class for CSS targeting", () => {
      expect(source).toContain("toolbar-project-chip-label");
    });

    it("CSS has container query to hide branch label at narrow widths", () => {
      expect(css).toContain("@container toolbar");
      expect(css).toContain("toolbar-project-chip-label");
      expect(css).toContain("display: none");
    });

    it("CSS has a second container-query tier that hides the entire chip at narrower widths — issue #8174", () => {
      // Below the second breakpoint the vestigial GitBranch icon shifts visual
      // weight without conveying anything (the branch label has already
      // dropped); hide the whole chip so the pill stays clean. The tooltip
      // remains the recovery surface for the branch name.
      expect(css).toMatch(
        /@container toolbar \(max-width:\s*560px\)[\s\S]*?\.toolbar-project-chip[^-][\s\S]*?display:\s*none/
      );
    });
  });

  describe("container query setup", () => {
    it("toolbar root has @container/toolbar class", () => {
      expect(source).toContain("@container/toolbar");
    });
  });

  describe("overflow state management", () => {
    it("closes dropdowns when items overflow", () => {
      expect(source).toMatch(/overflowSet\.has\("github-stats"\)/);
      expect(source).toMatch(/overflowSet\.has\("notification-center"\)/);
    });

    it("has overflow action handlers for menu items", () => {
      expect(source).toContain("overflowActions");
    });
  });

  describe("overflow trigger surfaces hidden state — issue #6416", () => {
    it("calls useOverflowBadgeSeverity for both left and right overflow", () => {
      expect(source).toContain("useOverflowBadgeSeverity(visibleLeftOverflow");
      expect(source).toContain("useOverflowBadgeSeverity(visibleRightOverflow");
    });

    it("passes left and right severities into renderOverflowMenu independently", () => {
      expect(source).toContain("leftOverflowSeverity");
      expect(source).toContain("rightOverflowSeverity");
    });

    it("maps severity to a CSS custom property via data-severity selectors", () => {
      // data-severity attribute is on the JSX element in Toolbar.tsx
      expect(source).toContain("data-severity={severity}");
      // The CSS custom property and severity mappings live in toolbar.css
      expect(css).toContain("--overflow-badge-color");
      expect(css).toContain('data-severity="critical"');
      expect(css).toContain('data-severity="warning"');
      expect(css).toContain('data-severity="info"');
      expect(css).toContain("var(--color-status-error)");
      expect(css).toContain("var(--color-state-waiting)");
    });

    it("renders a dot inside the overflow Button when severity is set", () => {
      expect(source).toContain("toolbar-overflow-badge");
      expect(source).toMatch(/data-severity=\{severity\}/);
    });

    it("builds a terse count-only tooltip — no enumerated list (issue #8159)", () => {
      // The enumerated list re-announced the full set on every focus pass
      // and went stale on resize; it must be gone entirely.
      expect(source).not.toContain("itemLabels");
      expect(source).not.toMatch(/\$\{overflowIds\.length\} more — /);
      // Tooltip is "More — {n} item(s)" / "More — {n} problem(s)".
      expect(source).toContain('`More — ${n} ${n === 1 ? "item" : "items"}`');
      expect(source).toContain('`More — ${n} ${n === 1 ? "problem" : "problems"}`');
    });

    it("escalates tooltip/aria noun to 'problem' for actionable severity (issue #8159)", () => {
      expect(source).toContain(
        'const hasProblem = severity === "critical" || severity === "warning";'
      );
    });

    it("uses a stable, count-bearing aria-label instead of the enumerated list (issue #8159)", () => {
      // voice-recording special-casing is gone — the tooltip/aria-label no
      // longer enumerate, so the count/list alignment hack is unnecessary.
      expect(source).not.toContain('id === "voice-recording"');
      expect(source).not.toContain('"Voice recording"');
      // aria-label is purpose-naming + count; severity escalates the noun.
      expect(source).toContain("`More toolbar items — ${n} hidden`");
      expect(source).toContain(
        '`More toolbar items — ${n} ${n === 1 ? "problem" : "problems"} hidden`'
      );
    });

    it("pins voice-recording out of overflow while actively recording — issue #8158", () => {
      // The toolbar must keep the live mic indicator visible regardless of
      // container width. The pinned set wires into useToolbarOverflow so the
      // button is excluded from the overflow budget while a recording is
      // active. The previous workaround (a hardcoded fallback label in the
      // overflow tooltip) is gone; reintroducing it would re-mask the bug.
      expect(source).toContain("VOICE_RECORDING_PINNED");
      // Pin applies to whichever side the button lives on — passed as a
      // single pinnedIds set into useToolbarOverflow, not a right-only param.
      expect(source).toMatch(/useToolbarOverflow\(\s*[\s\S]*?pinnedIds\s*\)/);
      expect(source).not.toContain('id === "voice-recording"');
      expect(source).not.toContain("OVERFLOW_DROPDOWN_SKIP");
    });
  });

  describe("toolbar button visual states — issue #7973", () => {
    it("focus-visible relies on outline alone — no hover background paint", () => {
      // Adversarial scan: walk every :focus-visible rule that targets a
      // toolbar button and assert none of them re-introduce a `background`
      // declaration (which would make keyboard focus indistinguishable from
      // mouse hover apart from the ring).
      const focusBlocks = Array.from(
        css.matchAll(/\.toolbar-(?:icon|agent)-button[^{]*?:focus-visible[^{]*?\{[^}]*?\}/g)
      ).map((m) => m[0]);
      expect(focusBlocks.length).toBeGreaterThan(0);
      for (const block of focusBlocks) {
        expect(block).toContain("outline: 2px solid var(--theme-accent-primary)");
        expect(block).not.toMatch(/\bbackground\b\s*:/);
      }
    });

    it("armed selectors carry an inset shadow on top of the emphasis background", () => {
      // The armed selector block must include both background AND box-shadow
      // so the state reads as anchored/pressed, not "still hovering". The shadow
      // shape is asserted as an inset hairline ring (0 0 0 1px) — the geometry
      // that distinguishes the state edge from a soft directional shadow that
      // reads as fog on low-contrast light themes (#7XXX).
      const armedBlock = css.match(
        /\.toolbar-icon-button\[aria-pressed="true"\][\s\S]*?\{[\s\S]*?\}/
      )?.[0];
      expect(armedBlock).toBeDefined();
      expect(armedBlock).toContain("--toolbar-control-armed-bg");
      expect(armedBlock).toContain("--toolbar-control-armed-shadow");
      expect(armedBlock).toMatch(/inset\s+0\s+0\s+0\s+1px/);
      expect(armedBlock).toContain('.toolbar-agent-button[aria-pressed="true"]');
    });

    it("armed selectors appear after :hover in source order so armed survives hover-over-armed", () => {
      // Hover and armed have equal specificity, so later-in-source wins. If a
      // refactor moves the armed block above hover, hovering an armed button
      // would erase the ring — silently regressing #8175.
      const hoverIndex = css.search(/\.toolbar-icon-button:hover\s*[,{]/);
      const armedIndex = css.search(/\.toolbar-icon-button\[aria-pressed="true"\]/);
      expect(hoverIndex).toBeGreaterThan(-1);
      expect(armedIndex).toBeGreaterThan(-1);
      expect(armedIndex).toBeGreaterThan(hoverIndex);
    });

    it("press transform is owned by base Button cva, not the toolbar transition list", () => {
      // The .toolbar-icon-button transition list must NOT include `transform` —
      // adding it would slow the cva's 1ms press-snap to 150ms.
      const baseBlock = css.match(
        /\.toolbar-icon-button,\s*\n\s*\.toolbar-agent-button\s*\{[\s\S]*?\}/
      )?.[0];
      expect(baseBlock).toBeDefined();
      expect(baseBlock).toMatch(/transition:[\s\S]*?;/);
      const transitionMatch = baseBlock!.match(/transition:[\s\S]*?;/)![0];
      expect(transitionMatch).not.toContain("transform");

      // The :active rule contributes background only; transform belongs to the cva.
      const activeBlock = css.match(
        /\.toolbar-icon-button:active,\s*\n\s*\.toolbar-agent-button:active\s*\{[\s\S]*?\}/
      )?.[0];
      expect(activeBlock).toBeDefined();
      expect(activeBlock).not.toMatch(/transform\s*:\s*scale/);
    });

    it("overflow severity dot uses a non-color shape differentiator per tier — WCAG 1.4.1", () => {
      // Tier 1 evidence: each severity owns its own border-radius in CSS, so
      // critical/warning/info are distinguishable without relying on color.
      expect(css).toMatch(
        /\.toolbar-overflow-badge\[data-severity="critical"\][\s\S]*?border-radius:\s*0;/
      );
      expect(css).toMatch(
        /\.toolbar-overflow-badge\[data-severity="warning"\][\s\S]*?border-radius:\s*2px;/
      );
      expect(css).toMatch(
        /\.toolbar-overflow-badge\[data-severity="info"\][\s\S]*?border-radius:\s*9999px;/
      );

      // Tier 2 evidence: the JSX className must NOT carry `rounded-full` or a
      // round `ring-*` utility — CSS data-attribute selectors own shape/ring so
      // they always agree (a round ring on a square dot would look like a bug).
      const badgeMatch = source.match(
        /<span[\s\S]*?data-testid="toolbar-overflow-badge"[\s\S]*?\/>/
      );
      expect(badgeMatch).toBeDefined();
      expect(badgeMatch![0]).not.toContain("rounded-full");
      // Adversarial: catches both numeric (`ring-1`) and named (`ring-daintree-bg/60`)
      // forms — a future contributor re-adding either would re-introduce a
      // round ring that contradicts the CSS shape rules.
      expect(badgeMatch![0]).not.toContain("ring-");
    });
  });

  describe("overflow menu focus ring after pointer dismissal — issue #6119", () => {
    it("declares the overflowMenuPointerCloseRef", () => {
      expect(source).toContain("overflowMenuPointerCloseRef");
      expect(source).toMatch(/overflowMenuPointerCloseRef\s*=\s*useRef\(false\)/);
    });

    it("sets the ref in onPointerDownOutside on the overflow DropdownMenuContent", () => {
      expect(source).toMatch(
        /onPointerDownOutside={\(\)\s*=>\s*{\s*overflowMenuPointerCloseRef\.current\s*=\s*true;?\s*}}/
      );
    });

    it("conditionally preventDefault and resets the ref in onCloseAutoFocus", () => {
      // Guards the reset line: deleting it would inherit suppression into a
      // later keyboard close and break WAI-ARIA focus return.
      expect(source).toContain("overflowMenuPointerCloseRef.current = false");
      expect(source).toMatch(
        /if\s*\(overflowMenuPointerCloseRef\.current\)\s*{\s*e\.preventDefault\(\);/
      );
    });
  });
});
