// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * WCAG 2.2 SC 2.5.3 (Label in Name): when a control carries an explicit
 * `aria-label`, the words visibly printed on it must appear inside that label,
 * so someone driving the app by voice can say what they can see.
 *
 * Both controls here previously failed it the same way — a label written as a
 * DESCRIPTION of the action ("Show project activity", "Browse 2 more resumable
 * sessions") instead of one that starts from the visible string. Each test
 * derives its expectation from what the component actually renders, so the
 * rule keeps holding when the wording changes; none of them pins a phrase.
 */
describe("Label in Name on the canvas-home context rows", () => {
  it("the collapsed pulse strip's accessible name opens with its visible label", async () => {
    vi.resetModules();
    const state = {
      getPulse: () => ({
        heatmap: [
          { date: "2026-06-02", count: 3, level: 3, isBeforeProject: false, isToday: false },
        ],
        commitsInRange: 9,
        activeDays: 5,
        projectAgeDays: 60,
        currentStreakDays: 2,
      }),
      isLoading: () => false,
      getError: () => null,
      fetchPulse: vi.fn(),
    };
    vi.doMock("@/store", () => ({
      usePulseStore: (s: (x: typeof state) => unknown) => s(state),
    }));
    vi.doMock("../../Pulse/ProjectPulseCard", () => ({ ProjectPulseCard: () => <div /> }));
    vi.doMock("../../Pulse/StreakFlame", () => ({ StreakFlame: () => <span /> }));
    const { ProjectPulseStrip } = await import("../../Pulse/ProjectPulseStrip");

    render(<ProjectPulseStrip worktreeId="wt1" />);
    const button = screen.getByRole("button");
    const label = button.getAttribute("aria-label") ?? "";

    // Read the visible label off the element rather than restating it, so this
    // asserts the relationship and not the copy.
    const visibleLabel = button.querySelector("span")?.textContent?.trim() ?? "";
    expect(visibleLabel.length).toBeGreaterThan(0);
    expect(label.toLowerCase().startsWith(visibleLabel.toLowerCase())).toBe(true);

    // The visible counts belong in the name too — the label replaces the
    // element's text content, so anything it omits is inaudible.
    expect(label).toContain("5 active day");
  });

  it("the '+N more' resume affordance keeps its visible string verbatim", async () => {
    vi.resetModules();
    vi.doMock("@/hooks/useWorktreeStore", () => ({ useWorktreeStore: () => new Map() }));
    vi.doMock("@/store/projectStore", () => ({ useProjectStore: () => "p1" }));
    vi.doMock("@/hooks/useResumeAgentSession", () => ({ useResumeAgentSession: () => vi.fn() }));
    vi.doMock("@/hooks/useAgentSessionRecords", () => ({
      useAgentSessionRecords: () => ({ sessions: [], hasLoaded: true }),
    }));
    vi.doMock("@/services/resumeSessionItems", () => ({
      buildResumeSessionItems: () => [
        { session: { sessionId: "a" }, name: "First", agentName: "Claude", isStale: false },
        { session: { sessionId: "b" }, name: "Second", agentName: "Claude", isStale: false },
        { session: { sessionId: "c" }, name: "Third", agentName: "Claude", isStale: false },
      ],
    }));
    vi.doMock("@/components/PanelPalette/PanelKindIcon", () => ({ PanelKindIcon: () => <span /> }));
    const { ResumeSessionLine } = await import("../ResumeSessionLine");

    render(<ResumeSessionLine />);
    const more = screen.getAllByRole("button").find((b) => (b.textContent ?? "").includes("more"))!;
    const visible = (more.textContent ?? "").trim();
    expect(visible).toMatch(/^\+\d+ more$/);
    // The leading "+" is the part that used to be dropped, and it is the part
    // a voice user would say.
    expect(more.getAttribute("aria-label") ?? "").toContain(visible);
  });
});

/**
 * Truncating controls on this surface must disclose their full label through a
 * mechanism that opens on KEYBOARD FOCUS, not only on hover.
 *
 * `title` is hover-only in every browser, and both of these controls are
 * ordinary tab stops whose names are `truncate`d — so a keyboard user arrowing
 * across "Migrate remaining J…" had no way to tell two long recipes apart
 * before launching one. Rendered against the REAL overlay primitives
 * (`vitest.setup.ts` primes the deferred Radix chunk), and driven by `focus`,
 * never by pointer events: a disclosure that only a hover can open is exactly
 * the bug. An earlier version of this guard scanned the source for the word
 * `TooltipTrigger`, which the import line satisfied on its own.
 */
describe("truncating launcher controls disclose their full label on focus", () => {
  it("the resume line opens a tooltip with the full name and description", async () => {
    vi.resetModules();
    const name = "Wire the OAuth device-flow refresh path end to end";
    const description = "feature/oauth-device-flow · Opus";
    vi.doMock("@/hooks/useWorktreeStore", () => ({ useWorktreeStore: () => new Map() }));
    vi.doMock("@/store/projectStore", () => ({ useProjectStore: () => "p1" }));
    vi.doMock("@/hooks/useResumeAgentSession", () => ({ useResumeAgentSession: () => vi.fn() }));
    vi.doMock("@/hooks/useAgentSessionRecords", () => ({
      useAgentSessionRecords: () => ({ sessions: [], hasLoaded: true }),
    }));
    vi.doMock("@/services/resumeSessionItems", () => ({
      buildResumeSessionItems: () => [
        { session: { sessionId: "a" }, name, description, agentName: "Claude", isStale: false },
      ],
    }));
    vi.doMock("@/components/PanelPalette/PanelKindIcon", () => ({ PanelKindIcon: () => <span /> }));
    // Same module registry for the provider and the component, or the two
    // resolve different context objects and the provider check throws.
    const [{ ResumeSessionLine }, { TooltipProvider }, { primeRadix }] = await Promise.all([
      import("../ResumeSessionLine"),
      import("@/components/ui/tooltip"),
      import("@/components/ui/radix-loader"),
    ]);
    // `vi.resetModules()` above discarded the loader `vitest.setup.ts` primed,
    // and an unprimed wrapper renders its no-Radix passthrough — no tooltip at
    // all, which would fail this test for the wrong reason.
    await primeRadix();

    render(
      <TooltipProvider delayDuration={0}>
        <ResumeSessionLine />
      </TooltipProvider>
    );
    const button = screen.getByRole("button", { name: new RegExp(name) });
    expect(screen.queryByRole("tooltip"), "closed before focus").toBeNull();

    fireEvent.focus(button);

    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain(name);
    // Below the narrow breakpoint the row drops the description entirely, so
    // the tooltip is the only place it survives.
    expect(tip.textContent).toContain(description);
  });

  it("a recipe card opens a tooltip on focus, through both composed triggers", async () => {
    vi.resetModules();
    const [{ RecipeRunnerItem }, { TooltipProvider }, { primeRadix }] = await Promise.all([
      import("../RecipeRunner/RecipeRunnerItem"),
      import("@/components/ui/tooltip"),
      import("@/components/ui/radix-loader"),
    ]);
    await primeRadix();
    const name = "Migrate remaining JavaScript modules to TypeScript";
    const recipe = {
      id: "migrate-ts",
      name,
      terminals: [{ type: "claude", title: "Claude", env: {} }],
      createdAt: 0,
    } as unknown as import("@/types").TerminalRecipe;
    const noop = () => {};
    let refTarget: HTMLButtonElement | null = null;

    render(
      <TooltipProvider delayDuration={0}>
        <RecipeRunnerItem
          recipe={recipe}
          isFocused={false}
          mode="grid"
          id="recipe-option-migrate-ts"
          tabIndex={0}
          buttonRef={(el) => {
            refTarget = el;
          }}
          onRun={noop}
          onEdit={noop}
          onDuplicate={noop}
          onPin={noop}
          onUnpin={noop}
          onDelete={noop}
        />
      </TooltipProvider>
    );

    const option = screen.getByRole("option", { name: new RegExp(name) });
    // Both `asChild` slots — ContextMenuTrigger outside, TooltipTrigger inside —
    // must compose down onto the ONE button the grid's roving tab stop holds a
    // ref to. If either wrapper swallowed the ref or the element, the grid
    // could not move focus here at all.
    expect(refTarget, "buttonRef must reach the real button").toBe(option);
    expect(option.getAttribute("data-state"), "ContextMenuTrigger is on the same node").toBe(
      "closed"
    );
    expect(screen.queryByRole("tooltip"), "closed before focus").toBeNull();

    fireEvent.focus(option);

    const tip = await screen.findByRole("tooltip");
    // The button's own text is already the accessible NAME, so the tooltip's
    // announced text is the summary only — the part the name lacks — rather
    // than the name a second time.
    expect(tip.textContent).not.toContain(name);
    expect(tip.textContent?.trim().length).toBeGreaterThan(0);
  });
});
