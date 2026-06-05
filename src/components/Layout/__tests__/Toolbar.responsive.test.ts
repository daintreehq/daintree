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

    it("CSS hides the whole branch chip in one step at 700px — issue #9824", () => {
      // Single-step collapse: label + icon drop together at 700px. The earlier
      // two-stage degradation hid the label at 700px and the chip at 560px,
      // leaving a lone GitBranch icon between the two; that vestigial icon-only
      // stage is gone. The tooltip remains the recovery surface for the branch.
      expect(css).toMatch(
        /@container toolbar \(max-width:\s*700px\)[\s\S]*?\.toolbar-project-chip[^-][\s\S]*?display:\s*none/
      );
    });

    it("has no standalone label-only hide rule — the icon-only intermediate stage is gone (issue #9824)", () => {
      // Guard against a regression that re-splits the collapse into two steps:
      // there must be no container query that hides toolbar-project-chip-label
      // on its own (which would resurrect the lone-icon stage).
      expect(css).not.toMatch(/\.toolbar-project-chip-label\s*\{[\s\S]*?display:\s*none/);
      // Also guard the non-display hide forms that would resurrect it.
      expect(css).not.toMatch(/\.toolbar-project-chip-label\s*\{[\s\S]*?visibility:\s*hidden/);
      expect(css).not.toMatch(/\.toolbar-project-chip-label\s*\{[\s\S]*?opacity:\s*0\b/);
      // And no 560px breakpoint remains for the chip.
      expect(css).not.toContain("max-width: 560px");
    });
  });

  describe("project pill interaction ladder — issue #9824", () => {
    it("lifts hover/armed/active via a ::before overlay, not by replacing the pill background", () => {
      // The pill's own background is the capsule fill (opaque near-white on light
      // themes). Replacing it on hover erased that fill; the lift must layer on a
      // ::before overlay instead so the capsule is preserved.
      expect(css).toMatch(/\.toolbar-project-pill::before\s*\{[\s\S]*?opacity:\s*0/);
      expect(css).toContain(".toolbar-project-pill:hover::before");
      expect(css).toContain('.toolbar-project-pill[aria-expanded="true"]::before');
      expect(css).toContain('.toolbar-project-pill[data-state="open"]::before');
      expect(css).toContain(".toolbar-project-pill:active::before");
    });

    it("overlay fades via opacity only — no transform/box-shadow/all in its transition", () => {
      // Tier 1 constraint: the lift animates opacity (the background-image layer
      // can't be transitioned). transform is owned by the base Button cva; the
      // pill must not slow or widen the transition list.
      const overlayBlock = css.match(/\.toolbar-project-pill::before\s*\{[\s\S]*?\}/)?.[0];
      expect(overlayBlock).toBeDefined();
      const transition = overlayBlock!.match(/transition:[\s\S]*?;/)?.[0];
      expect(transition).toBeDefined();
      expect(transition).toContain("opacity");
      expect(transition).not.toContain("transform");
      expect(transition).not.toContain("box-shadow");
      expect(transition).not.toContain("all");
    });

    it("armed/active overlay escalates after :hover in source order so armed survives hover-over-armed", () => {
      // Equal-specificity rules: later-in-source wins. A refactor that moves the
      // armed block above hover would erase the armed fill while hovering.
      const hoverIndex = css.search(/\.toolbar-project-pill:hover::before/);
      const armedIndex = css.search(/\.toolbar-project-pill\[aria-expanded="true"\]::before/);
      const activeIndex = css.search(/\.toolbar-project-pill:active::before/);
      expect(hoverIndex).toBeGreaterThan(-1);
      expect(armedIndex).toBeGreaterThan(hoverIndex);
      expect(activeIndex).toBeGreaterThan(armedIndex);
    });

    it("provides a forced-colors fallback for the armed pill — High Contrast strips the overlay tint", () => {
      // The armed lift is background-only (no inset ring), so Windows High
      // Contrast forces it to Canvas and the open pill reads as idle. A
      // ButtonText border restores the state edge, mirroring the icon-button.
      const forcedColorsBlock = css.match(
        /@media \(forced-colors: active\)\s*\{[\s\S]*?border:\s*2px solid ButtonText[\s\S]*?\}/
      )?.[0];
      expect(forcedColorsBlock).toBeDefined();
      expect(forcedColorsBlock).toContain('.toolbar-project-pill[aria-expanded="true"]');
      expect(forcedColorsBlock).toContain('.toolbar-project-pill[data-state="open"]');
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

    it("radio chips (aria-checked) share the armed-state recipe across base, light, and forced-colors blocks", () => {
      // Segmented radio chips (viewport preset / DPR) carry role=radio + aria-checked
      // rather than aria-pressed. For them to read with the same theme-aware armed
      // styling — and not fall back to a hardcoded fill that smudges on light themes —
      // every armed block must enumerate aria-checked alongside aria-pressed.
      const armedSelectorIndex = css.indexOf('.toolbar-icon-button[aria-checked="true"]');
      const lightFlipIndex = css.indexOf(
        ':where(.light, [data-color-mode="light"]) .toolbar-icon-button[aria-checked="true"]'
      );
      const forcedColorsBlock = css.match(
        /@media \(forced-colors: active\)\s*\{[\s\S]*?aria-pressed[\s\S]*?\}\s*\}/
      )?.[0];

      expect(armedSelectorIndex).toBeGreaterThan(-1);
      expect(lightFlipIndex).toBeGreaterThan(-1);
      expect(forcedColorsBlock).toBeDefined();
      expect(forcedColorsBlock).toContain('.toolbar-icon-button[aria-checked="true"]');
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

    it("armed-state ring is excluded from toolbar transition list so it snaps — same pattern as press transform", () => {
      // The .toolbar-icon-button transition list must NOT include `box-shadow` —
      // arming is the result of an intentional click/keypress; the ring should snap,
      // not crossfade over 150ms. `color` and `background-color` remain at 150ms
      // for visual cohesion with hover.
      const baseBlock = css.match(
        /\.toolbar-icon-button,\s*\n\s*\.toolbar-agent-button\s*\{[\s\S]*?\}/
      )?.[0];
      expect(baseBlock).toBeDefined();
      expect(baseBlock).toMatch(/transition:[\s\S]*?;/);
      const transitionMatch = baseBlock!.match(/transition:[\s\S]*?;/)![0];
      expect(transitionMatch).not.toContain("box-shadow");
      expect(transitionMatch).not.toContain("all");
      expect(transitionMatch).toMatch(/\bcolor\b/);
      expect(transitionMatch).toContain("background-color");

      // Guard: no later rule in the same file reintroduces box-shadow or
      // transition:all on these classes.
      for (const block of css.match(/\.toolbar-(?:icon|agent)-button[\s\S]*?\{[\s\S]*?\}/g) ?? []) {
        const t = block.match(/transition:[\s\S]*?;/)?.[0];
        if (!t) continue;
        if (block.includes("box-shadow") && t.includes("box-shadow")) {
          // Armed-state block sets box-shadow but not in a transition list —
          // only flag it if box-shadow appears inside the transition value.
        }
        expect(t).not.toContain("all");
        if (block === baseBlock) continue; // already checked above
        expect(t).not.toMatch(/box-shadow\s+150ms/);
      }
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

  describe("agent split-button seam — issue #9823", () => {
    // The seam is implemented as a custom toolbar.css class (not a Tailwind
    // utility) because .border-divider resolves to the plain --border-divider
    // alias and skips the --toolbar-divider override chain. The chevron's
    // open-state suppression is asserted as a CSS source guard so a future
    // refactor cannot silently drop the suppression — which would let the
    // 1px right border stack with the chevron's inset 1px border-strong
    // armed ring into a 2px smudge on light themes (the same failure mode
    // the L97-117 comment block above documents).

    it("declares the toolbar-agent-split-seam class", () => {
      expect(css).toContain(".toolbar-agent-split-seam");
    });

    it("paints the seam with the --toolbar-divider chain (matches .toolbar-divider)", () => {
      // Verify the seam rule body uses the same fallback chain as the
      // existing .toolbar-divider so per-theme --toolbar-divider overrides
      // apply identically. A regression that hardcodes a color here would
      // break the theme-tokened contract.
      const seamBlock = css.match(/\.toolbar-agent-split-seam\s*\{[^}]*\}/)?.[0];
      expect(seamBlock).toBeDefined();
      expect(seamBlock).toContain("border-right-color");
      expect(seamBlock).toContain("var(--toolbar-divider, var(--theme-border-divider))");
    });

    it("suppresses the seam when the chevron is armed via :has() on group/agent-split", () => {
      // The suppression anchors on .toolbar-agent-button[data-state="open"]
      // (the same selector the existing armed-state block above uses) so
      // the trigger path is shared. The :has() sits on .group\/agent-split
      // to scope the rule to the split-button JSX, not bare toolbar buttons.
      // (CSS escapes the `/` so the on-disk literal is `\/`.)
      expect(css).toContain('.group\\/agent-split:has(.toolbar-agent-button[data-state="open"])');
      expect(css).toContain("border-right-color: transparent");
    });

    it("provides a forced-colors fallback so the seam survives Windows High Contrast", () => {
      // Without the ButtonText fallback, Windows High Contrast would force
      // the seam to Canvas (invisible) and the split-button structure would
      // read as a single button — losing the discoverability win the issue
      // asks for.
      const forcedColorsBlock = css.match(
        /@media \(forced-colors: active\)\s*\{[\s\S]*?\.toolbar-agent-split-seam[\s\S]*?\}/
      )?.[0];
      expect(forcedColorsBlock).toBeDefined();
      expect(forcedColorsBlock).toContain("border-right-color: ButtonText");
    });
  });
});
