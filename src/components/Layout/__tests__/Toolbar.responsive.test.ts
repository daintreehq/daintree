import { describe, it, expect, beforeEach } from "vitest";
import { readToolbarCss } from "@/__tests__/support/cssManifest";
import { extractAtRuleBlocks } from "./cssBlocks";
import { readToolbarSource } from "./toolbarSource";

describe("Toolbar responsive design — issue #4133", () => {
  let source: string;
  let css: string;

  beforeEach(async () => {
    [source, css] = await Promise.all([readToolbarSource(), Promise.resolve(readToolbarCss())]);
  });

  describe("overflow hook integration", () => {
    it("renders data-toolbar-button-id measurement wrappers", () => {
      expect(source).toContain("data-toolbar-button-id={");
    });
  });

  describe("branch chip responsive collapse", () => {
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
      expect(source).toMatch(/overflowSet\.has\("forge-stats"\)/);
      expect(source).toMatch(/overflowSet\.has\("notification-center"\)/);
    });
  });

  describe("overflow trigger surfaces hidden state — issue #6416", () => {
    it("calls useOverflowBadgeSeverity for both left and right overflow", () => {
      expect(source).toMatch(/useOverflowBadgeSeverity\(\s*visibleLeftOverflow/);
      expect(source).toMatch(/useOverflowBadgeSeverity\(\s*visibleRightOverflow/);
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

    it("builds a terse count-bearing tooltip — no enumerated list (issue #8159)", () => {
      // The enumerated list re-announced the full set on every focus pass
      // and went stale on resize; it must be gone entirely.
      expect(source).not.toContain("itemLabels");
      expect(source).not.toMatch(/\$\{overflowIds\.length\} more — /);
      expect(source).toContain("`More — ${n} hidden");
    });

    it("never re-nouns the hidden count as 'problems' — the count is always of hidden items", () => {
      // Severity used to swap the noun, so five hidden commands announced as
      // five problems. The count is a count; the signal rides behind it.
      expect(source).not.toMatch(/n === 1 \? "problem" : "problems"/);
      expect(source).not.toContain("hasProblem");
      expect(source).toContain("`More toolbar items — ${n} hidden");
    });

    it("appends what the badge reports, as observations, to both the tooltip and the name", () => {
      const block = source.match(
        /const observations: string\[\] = \[\];[\s\S]*?const ariaLabel = [^;]*;/
      );
      expect(block).not.toBeNull();
      const text = block![0];
      // Each signal the badge severity is derived from has a textual counterpart.
      expect(text).toMatch(/overflowIds\.includes\("problems"\) && errorCount > 0/);
      // Unread and urgent ride on the same marks the menu rows wear.
      expect(text).toMatch(/for \(const id of \["notification-center", "canopy"\] as const\)/);
      expect(text).toMatch(/signalMark\(id\)/);
      // Agent observations come from the same per-session derivation as the
      // badge severity, never from the per-agent pip map — the name counts
      // every session, where the map holds one state per agent.
      expect(text).toMatch(/observations\.push\(\.\.\.agentObservations\)/);
      expect(text).not.toMatch(/agentAttentionStates\.get\(id\)/);
      expect(text).not.toMatch(/needs attention|requires attention/);
      // The observations are joined into the tooltip and the aria-label.
      expect(text).toMatch(/tooltipText = `More — \$\{n\} hidden\$\{observations\.length > 0 \?/);
      expect(text).toMatch(
        /ariaLabel = `More toolbar items — \$\{n\} hidden\$\{observations\.length > 0 \?/
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
      expect(source).toMatch(/useToolbarOverflow\(\s*[\s\S]*?pinnedIds\s*[,)]/);
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

    it("keeps geometry out of the toolbar transition list and the press", () => {
      // The toolbar press is a fill step only (toolbarPress.contract.test.ts);
      // a transform in the transition list would animate one back in.
      const baseBlock = css.match(
        /\.toolbar-icon-button,\s*\n\s*\.toolbar-agent-button\s*\{[\s\S]*?\}/
      )?.[0];
      expect(baseBlock).toBeDefined();
      expect(baseBlock).toMatch(/transition:[\s\S]*?;/);
      const transitionMatch = baseBlock!.match(/transition:[\s\S]*?;/)![0];
      expect(transitionMatch).not.toContain("transform");

      // The :active rule paints the pressed fill and never a transform.
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
      // Tier 1 evidence: each severity owns its own shape in CSS, so the tiers
      // are distinguishable without relying on color: critical a square,
      // warning and notice a slightly rounded square, waiting the hollow ring,
      // info the round pip it inherits.
      const ruleFor = (severity: string) =>
        new RegExp(
          `[^{}]*\\.toolbar-overflow-badge(?::is\\([^)]*)?\\[data-severity="${severity}"\\][^{}]*\\{[^}]*\\}`
        );
      const radius = (severity: string, value: string) =>
        (css.match(new RegExp(ruleFor(severity).source, "g")) ?? []).some((rule) =>
          new RegExp(`border-radius:\\s*${value};`).test(rule)
        );
      expect(radius("critical", "0")).toBe(true);
      expect(radius("warning", "2px")).toBe(true);
      expect(radius("notice", "2px")).toBe(true);
      expect(
        (css.match(new RegExp(ruleFor("waiting").source, "g")) ?? []).some((rule) =>
          /border:\s*1\.5px solid/.test(rule)
        )
      ).toBe(true);
      expect(css).toMatch(/\.toolbar-pip\s*\{[^}]*border-radius:\s*9999px;/);
      expect(source).toMatch(/toolbar-pip toolbar-overflow-badge/);

      // Tier 2 evidence: the JSX className must NOT carry `rounded-full` or a
      // round `ring-*` utility — CSS data-attribute selectors own shape/ring so
      // they always agree (a round ring on a square dot would look like a bug).
      const badgeMatch = source.match(
        /<span(?:(?!<span)[\s\S])*?data-testid="toolbar-overflow-badge"[\s\S]*?\/>/
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

  describe("agent split button — one control at rest", () => {
    // A permanent full-height seam read as a stronger boundary than the real
    // group dividers either side of it, splitting an agent run in two. The
    // partition is now drawn only while the split is in use, and never at
    // rest outside forced colors.
    const block = (selector: RegExp) => css.match(selector)?.[0];

    it("hides the partition at rest", () => {
      const partition = block(/\.toolbar-agent-split-toggle::before\s*\{[^}]*\}/);
      expect(partition).toBeDefined();
      expect(partition).toMatch(/opacity:\s*0;/);
      expect(partition).toContain("pointer-events: none");
    });

    it("reveals the partition only on a live split under hover or focus", () => {
      const reveal = block(
        /\.toolbar-agent-split\[data-split-live="true"\]:is\(:hover, :focus-within\)\s*\.toolbar-agent-split-toggle::before\s*\{[^}]*\}/
      );
      expect(reveal).toBeDefined();
      expect(reveal).toMatch(/opacity:\s*1;/);
    });

    it("paints the partition with the --toolbar-divider chain", () => {
      const partition = block(/\.toolbar-agent-split-toggle::before\s*\{[^}]*\}/);
      expect(partition).toContain("var(--toolbar-divider, var(--theme-border-divider))");
    });

    it("drops the partition while the chevron is open, where its armed ring draws that edge", () => {
      const suppressed = block(
        /\.toolbar-agent-split \.toolbar-agent-split-toggle\[aria-expanded="true"\]::before\s*\{[^}]*\}/
      );
      expect(suppressed).toBeDefined();
      expect(suppressed).toMatch(/opacity:\s*0;/);
    });

    it("keys the open state on aria-expanded, which the tooltip trigger can't overwrite", () => {
      // The chevron is a tooltip trigger too, and the tooltip's data-state
      // ("closed", "delayed-open") lands on the same element, so a
      // [data-state="open"] selector never matches while the menu is open.
      expect(css).toContain(
        '.toolbar-agent-split:has(.toolbar-agent-split-toggle[aria-expanded="true"])'
      );
      expect(css).not.toMatch(/\.toolbar-agent-split[^{]*\[data-state="open"\]/);
    });

    it("keeps the partition drawn at rest in forced colors, where the wash is gone", () => {
      const forced = block(
        /@media \(forced-colors: active\)\s*\{\s*\.toolbar-agent-split\[data-split-live="true"\] \.toolbar-agent-split-toggle::before\s*\{[^}]*\}/
      );
      expect(forced).toBeDefined();
      expect(forced).toMatch(/opacity:\s*1;/);
      expect(forced).toContain("ButtonText");
    });
  });
});

// Issue #9821 — the `…` overflow menu dropped every contextual signal the
// evicted toolbar buttons carry (error/unread counts, agent-state dots,
// keyboard shortcuts, the GitHub group label), gave no feedback when copy-tree
// fired from overflow, and the trigger popped in/out without an animation.
// These are static-source assertions (the rest of the Toolbar.* suite uses the
// same approach — Toolbar.tsx has too many IPC dependencies to render in jsdom).
describe("Toolbar overflow menu state preservation — issue #9821", () => {
  let source: string;
  let css: string;

  beforeEach(async () => {
    [source, css] = await Promise.all([readToolbarSource(), Promise.resolve(readToolbarCss())]);
  });

  describe("per-item counts", () => {
    it("appends the error count to the problems item and unread count to notifications", () => {
      // countSuffix derives both from the same primitives the source buttons use.
      expect(source).toMatch(/id === "problems" && errorCount > 0/);
      expect(source).toMatch(/id === "notification-center" && notificationUnreadCount > 0/);
    });
  });

  describe("agent-state dots", () => {
    it("derives a per-agent pip state map scoped to the active worktree", () => {
      expect(source).toContain("agentAttentionStates");
      // Shared with the launcher so the overflow dot matches the visible
      // agent button; computed inside useShallow so agent ticks that don't
      // change a pip state don't re-render the toolbar. The fleet's needs-you
      // runs are passed in so only an unread Canopy ask earns the waiting dot.
      expect(source).toMatch(
        /useShallow\(\(s\) =>\s*deriveAgentAttentionStates\(\s*s\.panelsById,\s*s\.panelIds,\s*activeWorktreeId,\s*needsYouRunIds\s*\)/
      );
    });

    it("renders the dot through a dedicated component that shows the agent's own binding", () => {
      expect(source).toContain("function AgentOverflowItem");
      expect(source).toContain("keybinding={`agent.${id}`}");
      expect(source).toContain("agentStateDotColor(attentionState)");
      // The pip is aria-hidden, so the row's accessible name carries its state.
      expect(source).toMatch(/sr-only[^\n]*STATE_LABELS\[attentionState\]/);
    });
  });

  describe("keyboard shortcut hints", () => {
    // The menu primitive draws each item's live binding from the action id it is
    // handed, so what must hold here is the id → action mapping and its use.
    const EXPECTED: Record<string, string> = {
      "copy-tree": "worktree.copyTree",
      "notification-center": "notifications.toggle",
      "command-palette": "action.palette.open",
      "dev-server": "devServer.start",
      // These all show a shortcut hint on their visible toolbar button, so the
      // overflow item must too (issue #9821).
      settings: "app.settings",
      problems: "panel.toggleDiagnostics",
      terminal: "agent.terminal",
      browser: "agent.browser",
      // #11495
      "file-browser": "worktree.openFileBrowserPanel",
    };

    it("maps each shortcut-bearing item id to the action whose binding it shows", () => {
      const block = /const OVERFLOW_KEYBINDING_BY_ID[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
      expect(block, "OVERFLOW_KEYBINDING_BY_ID not found").not.toBeNull();
      for (const [id, actionId] of Object.entries(EXPECTED)) {
        const key = /^[a-z]+$/.test(id) ? id : `"${id}"`;
        expect(block![1]).toMatch(
          new RegExp(`${key.replace(/[-]/g, "\\-")}:\\s*"${actionId.replace(/\./g, "\\.")}"`)
        );
      }
    });

    it("hands every overflow row its binding through the menu primitive", () => {
      expect(source).toContain("keybindingById={OVERFLOW_KEYBINDING_BY_ID}");
      expect(source).toMatch(/keybinding=\{keybindingById\[item\.id\]\}/);
      expect(source).toMatch(/keybinding=\{keybindingById\[id\]\}/);
    });
  });

  describe("file browser overflow item — issue #11495", () => {
    it("reuses the visible button's handler rather than re-dispatching inline", () => {
      // One handler for the button, the overflow item, and the Retry action, so
      // the refusal path can't drift between them.
      expect(source).toMatch(/"file-browser":\s*openFileBrowser,/);
    });

    it("surfaces the refusal instead of pressing silently", () => {
      // The action resolves its own target and throws when a workspace has
      // nothing to browse; dispatch converts that to ok:false, so without this
      // branch the press would do nothing at all.
      expect(source).toMatch(/if \(result\.ok\) return;/);
      expect(source).toContain("Couldn't open the file browser");
      expect(source).toMatch(/label: "Retry", onClick: openFileBrowser/);
    });

    it("leaves the already-reported full-grid refusal alone (#11666)", () => {
      // Now that the button opens a real panel it can also be refused for a
      // full grid — which `addPanel` has already reported accurately. The
      // workspace-shaped message must not fire on top of it.
      expect(source).toMatch(/if \(isPanelLimitError\(result\.error\.message\)\) return;/);
    });
  });

  describe("review fixes", () => {
    it("resets controlled open state when the menu empties so it doesn't self-reopen", () => {
      // Without this, widening then re-narrowing the window pops the overflow
      // menu open with no user action.
      expect(source).toMatch(
        /useEffect\(\(\)\s*=>\s*\{\s*if \(isEmpty\) setOpen\(false\);?\s*\}, \[isEmpty\]\)/
      );
    });

    it("disables the overflow copy-tree item exactly when its handler would refuse", () => {
      // Mirrors the visible button's aria-disabled states: nothing to copy yet
      // and a copy already in flight — which can start from routes that never
      // touch this menu (MCP, Cmd+Shift+C), so the item must not look live
      // while activation would silently no-op. A worktree-less workspace still
      // copies its root (#13210), so it must not disable the item.
      expect(source).toMatch(/id === "copy-tree" && \(!canCopyTree \|\| isCopyingTree\)/);
      expect(source).toContain("canCopyTree={canCopyTree}");
      expect(source).toMatch(
        /const canCopyTree =\s*Boolean\(activeWorktree\) \|\| \(hasWorkspace && \(!currentProject \|\| worktreeListEmpty\)\)/
      );
      expect(source).toContain("disabled={disabled}");
    });

    it("says why the copy-tree row is disabled while a copy is in flight", () => {
      // A greyed row alone reads as unavailable, not busy. The in-flight state
      // must change what the row says, not only its opacity, and its spinner
      // takes the same Doherty gate as the visible button's so a quick copy
      // never flashes one.
      const menu = source.match(/function OverflowMenu[\s\S]*?\n}\n/);
      expect(menu).not.toBeNull();
      const flag = menu![0].match(/const (\w+) = id === "copy-tree" && isCopyingTree;/);
      expect(flag).not.toBeNull();
      const copying = flag![1]!;
      expect(menu![0]).toContain("const showCopyingSpinner = useDohertyGate(isCopyingTree);");
      expect(menu![0]).toMatch(
        new RegExp(`\\{${copying} && showCopyingSpinner \\?\\s*\\(?\\s*<Spinner`)
      );
      const label = menu![0].match(new RegExp(`\\{${copying} \\? "([^"]+)" : meta\\.label\\}`));
      expect(label).not.toBeNull();
      expect(label![1]).toMatch(/…$/);
      // The busy label's width is reserved in the same cell, so an open menu
      // doesn't resize when a copy starts or lands.
      expect(menu![0]).toMatch(
        new RegExp(`aria-hidden="true" className="invisible[^"]*">\\s*${label![1]}\\s*<`)
      );
    });
  });

  describe("forge-stats group label", () => {
    it("wraps the three forge items in a group labelled with the provider name", () => {
      // DropdownMenuLabel alone is insufficient — the Group wires role=group +
      // aria-labelledby so the boundary is announced.
      expect(source).toMatch(
        /<DropdownMenuGroup[\s\S]*?<DropdownMenuLabel[^>]*>\s*\{forgeProviderName\}[\s\S]*?<\/DropdownMenuLabel>/
      );
    });
  });

  describe("copy-tree feedback from overflow — #9821, superseded by #11735", () => {
    it("keeps the overflow item on the immediate-copy handler the panel also calls", () => {
      // #9821 gave overflow its own handler because the visible button's only
      // feedback was an inline check the overflow menu couldn't show. Once
      // completion became a toast from the `worktree.copyTree` action, both
      // routes collapsed onto one handler — and #11733 kept it that way rather
      // than nesting a panel inside the overflow menu. So the overflow row and
      // the panel's own "Copy full context" row must reach the SAME handler;
      // a second one could only drift from the first.
      expect(source).toMatch(/"copy-tree":\s*\(\)\s*=>\s*\{\s*void handleCopyTreeClick\(\)/);
      expect(source).not.toContain("handleCopyTreeOverflow");
      expect(source).toMatch(
        /const handleCopyTreeFullContext = useCallback\(\(\) => \{[\s\S]*?void handleCopyTreeClick\(\)/
      );
    });

    it("routes the visible button to the menu, not to the immediate copy (#11733)", () => {
      // The half of the split that is easy to regress: re-pointing the trigger
      // back at the immediate handler would restore one-click copying and
      // silently strand the menu. Asserted on the block rather than the file
      // because the immediate handler still legitimately appears elsewhere.
      const copyTreeBlock = source.match(/"copy-tree":\s*\{[\s\S]*?isAvailable/);
      expect(copyTreeBlock).not.toBeNull();
      // The button is the menu's trigger, and the menu's open state is what
      // the toolbar controls — not a click handler on the button.
      expect(copyTreeBlock![0]).toContain("<DropdownMenuTrigger asChild>");
      expect(copyTreeBlock![0]).toContain("onOpenChange={handleCopyTreeOpenChange}");
      expect(copyTreeBlock![0]).not.toContain("onClick={handleCopyTreeClick}");
    });

    it("no longer raises its own copy-tree toast in the toolbar", () => {
      // The toolbar must not re-announce what the action already announces;
      // two toasts per press was the failure mode this consolidation prevents.
      expect(source).not.toMatch(/notify\(\{[\s\S]{0,200}?title: "Context copied"/);
    });
  });

  describe("trigger entry/exit animation", () => {
    it("keeps the trigger mounted and toggles data-visible instead of returning null", () => {
      expect(source).toContain('data-visible={isEmpty ? "false" : "true"}');
      // The empty trigger must drop out of roving focus and not be clickable.
      expect(source).toContain("aria-hidden={isEmpty || undefined}");
      expect(source).toContain("tabIndex={isEmpty ? -1 : undefined}");
    });

    it("forces the menu closed when empty while staying controlled (no React warning)", () => {
      expect(source).toMatch(/open=\{isEmpty \? false : open\}/);
    });

    it("animates the trigger via @starting-style + allow-discrete, opacity-only", () => {
      expect(css).toMatch(
        /\[data-toolbar-overflow-trigger\]\s*\{[\s\S]*?display:\s*none;[\s\S]*?allow-discrete/
      );
      expect(css).toMatch(
        /\[data-toolbar-overflow-trigger\]\[data-visible="true"\][\s\S]*?@starting-style/
      );
      // Opacity-only — no scale transform like the pip badge uses.
      const triggerBlock = css.match(
        /\[data-toolbar-overflow-trigger\]\[data-visible="true"\]\s*\{[\s\S]*?\}/
      )?.[0];
      expect(triggerBlock).toBeDefined();
      expect(triggerBlock).not.toContain("scale");
    });

    it("keeps its timed display swap under reduced motion, so the fade-out paints — lesson #6182", () => {
      // The trigger only fades, so reduced motion has nothing to remove. A
      // reduce-motion override that zeroed the display swap (`display 0s`)
      // dropped it to display:none before its opacity exit could paint.
      // Brace-walk the blocks rather than regexing across them.
      for (const block of extractAtRuleBlocks(css, "@variant reduce-motion")) {
        const rule = block.match(/\[data-toolbar-overflow-trigger\][^{]*\{[^{}]*\}/)?.[0] ?? "";
        expect(rule).not.toMatch(/display\s+0s|transition:\s*none/);
      }
      expect(css).toMatch(
        /\[data-toolbar-overflow-trigger\]\s*\{[^{}]*display\s+var\(--duration-\d+\)\s+allow-discrete/
      );
    });
  });
});
