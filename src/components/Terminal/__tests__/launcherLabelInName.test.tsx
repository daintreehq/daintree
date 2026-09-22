// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
