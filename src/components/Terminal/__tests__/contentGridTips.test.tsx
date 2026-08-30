// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@/hooks/useKeybinding", () => ({
  useKeybindingDisplay: () => "",
}));

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch },
}));

const { isAgentLaunchableMock } = vi.hoisted(() => ({
  isAgentLaunchableMock: vi.fn((_arg: unknown) => true),
}));
vi.mock("../../../../shared/utils/agentAvailability", () => ({
  isAgentLaunchable: (arg: unknown) => isAgentLaunchableMock(arg),
}));

import { RotatingTip, TIPS } from "../contentGridTips";
import { keybindingService } from "@/services/KeybindingService";
import { shortcutHintStore } from "@/store/shortcutHintStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";

function setHydrated(counts: Record<string, number> = {}) {
  act(() => {
    shortcutHintStore.setState({ counts, hydrated: true });
  });
}

function setUnhydrated() {
  shortcutHintStore.setState({
    counts: {},
    hydrated: false,
    pointer: null,
    activeHint: null,
    hintedHover: new Set(),
  });
}

function makeAvailability(state: "ready" | "missing") {
  return {
    claude: state,
    gemini: state,
    codex: state,
    terminal: state,
  } as never;
}

/**
 * The label the tip catalog gives an action. These tests are about which tip
 * gets SELECTED, so they resolve the expected text from `TIPS` rather than
 * restating it — a copy change should not fail a selection test, and a literal
 * here would have to be edited in lockstep with the source it is checking.
 */
function labelFor(actionId: string): string | undefined {
  return TIPS.find((tip) => (tip.shortcutActionId ?? tip.actionId) === actionId)?.actionLabel;
}

describe("RotatingTip — count-biased selection (#6756)", () => {
  beforeEach(() => {
    setUnhydrated();
    useCliAvailabilityStore.setState({ availability: makeAvailability("ready") });
    dispatch.mockClear();
    isAgentLaunchableMock.mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    isAgentLaunchableMock.mockReturnValue(true);
  });

  it("reserves an invisible slot while shortcutHintStore is not hydrated (#7671)", () => {
    // Returning null would pop the tip in once shortcutHints hydrates a few
    // ticks after first paint, shifting the empty-state column. The
    // placeholder is aria-hidden so screen readers skip it.
    const { container } = render(<RotatingTip />);
    const placeholder = container.firstChild as HTMLElement | null;
    expect(placeholder).not.toBeNull();
    expect(placeholder!.getAttribute("aria-hidden")).toBe("true");
    expect(placeholder!.className).toContain("invisible");
    expect(container.textContent ?? "").not.toMatch(/Tip:/);
  });

  it("renders a tip once hydrated", () => {
    const { container } = render(<RotatingTip />);
    expect(container.textContent ?? "").not.toMatch(/Tip:/);
    setHydrated();
    expect(container.querySelector("p")?.textContent).toMatch(/^Tip:/);
  });

  it("placeholder shares the hydrated tip's column structure so swap doesn't shift layout (#7671)", () => {
    // The anti-jump invariant: the unhydrated placeholder must match the
    // rendered tip's outer flex layout and child count, so when shortcutHints
    // hydrates the swap doesn't change the column's height.
    const { container, rerender } = render(<RotatingTip />);
    const before = container.firstChild as HTMLElement | null;
    expect(before).not.toBeNull();
    const beforeClasses = before!.className;
    const beforeChildCount = before!.childElementCount;

    setHydrated();
    rerender(<RotatingTip />);
    const after = container.firstChild as HTMLElement | null;
    expect(after).not.toBeNull();

    // Same flex column shape (items-center gap-2) and same row count.
    expect(after!.className).toContain("flex flex-col items-center gap-2");
    expect(beforeClasses).toContain("flex flex-col items-center gap-2");
    expect(after!.childElementCount).toBe(beforeChildCount);
  });

  it("biases toward an unused (zero-count) actionId over high-count ones", () => {
    // Math.random=0 always picks the first item in the prioritized subset.
    vi.spyOn(Math, "random").mockReturnValue(0);
    // Saturate every shortcut except `terminal.inject` so it is the unique
    // zero-count tip and must be at index 0 of the sorted prioritized subset.
    const counts: Record<string, number> = {};
    for (const tip of TIPS) {
      if (tip.actionId && tip.actionId !== "terminal.inject") {
        counts[tip.actionId] = 999;
      }
    }
    const { container } = render(<RotatingTip />);
    setHydrated(counts);
    expect(container.querySelector("button")?.textContent).toBe(labelFor("terminal.inject"));
  });

  it("excludes shortcut-dependent tips whose binding has been removed", () => {
    // terminal.inject is the unique zero-count tip, so it would win the bias —
    // but its binding is gone, so it must be filtered from the candidate pool
    // instead of rendering the hardcoded ⌘-glyph fallback.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const realGetDisplayCombo = keybindingService.getDisplayCombo.bind(keybindingService);
    vi.spyOn(keybindingService, "getDisplayCombo").mockImplementation((actionId: string) =>
      actionId === "terminal.inject" ? "" : realGetDisplayCombo(actionId)
    );
    const counts: Record<string, number> = {};
    for (const tip of TIPS) {
      const key = tip.shortcutActionId ?? tip.actionId;
      if (key && key !== "terminal.inject") {
        counts[key] = 999;
      }
    }
    const { container } = render(<RotatingTip />);
    setHydrated(counts);
    expect(container.querySelector("button")?.textContent).not.toBe("Inject Context");
    expect(container.textContent ?? "").not.toContain("⌘⇧I");
  });

  it("limits selection to the lowest-count subset (high-count tips never win)", () => {
    // Math.random=0.999... → last index of the prioritized subset.
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    // Every tip has a count except quick-switcher; force quick-switcher's count
    // to exceed all others so it should be excluded from the lowest-N subset.
    // Build counts so the 4-tip subset is { actionA, actionB, actionC, actionD }
    // and quick-switcher has the highest count.
    const counts: Record<string, number> = {};
    TIPS.forEach((tip, idx) => {
      if (!tip.actionId) return;
      // Stagger counts so subset boundary is well-defined.
      counts[tip.actionId] = idx === 0 ? 9999 : idx;
    });
    const { container } = render(<RotatingTip />);
    setHydrated(counts);
    // quick-switcher has by far the largest count; it must NOT be the chosen tip.
    expect(container.querySelector("button")?.textContent).not.toBe(labelFor("nav.quickSwitcher"));
  });

  it("freezes the chosen tip — count updates after mount do not swap it", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const counts: Record<string, number> = {};
    for (const tip of TIPS) {
      if (tip.actionId && tip.actionId !== "nav.quickSwitcher") {
        counts[tip.actionId] = 999;
      }
    }
    const { container } = render(<RotatingTip />);
    setHydrated(counts);
    const before = container.querySelector("button")?.textContent;
    expect(before).toBe(labelFor("nav.quickSwitcher"));

    // Simulate the user invoking some other shortcut after the tip mounted.
    act(() => {
      shortcutHintStore.setState({
        counts: { ...counts, "terminal.inject": 5 },
      });
    });

    const after = container.querySelector("button")?.textContent;
    expect(after).toBe(before);
  });

  it("still renders non-agent tips when all agents are unavailable", () => {
    // Confirms over-filtering doesn't strip the rotation entirely — most tips
    // have no `requiredAgents`, so they survive even when every agent is missing.
    useCliAvailabilityStore.setState({ availability: makeAvailability("missing") });
    const { container } = render(<RotatingTip />);
    setHydrated();
    expect(container.querySelector("p")?.textContent).toMatch(/^Tip:/);
  });

  it("renders null when filteredTips is empty (no tip survives filtering)", () => {
    // Drive `filteredTips.length === 0` by treating every tip as agent-gated and
    // marking every agent as unlaunchable. Exercises the empty-filter branch
    // in the useEffect guard.
    isAgentLaunchableMock.mockReturnValue(false);
    useCliAvailabilityStore.setState({ availability: makeAvailability("missing") });
    // Patch every TIPS entry to require an agent so none survive the filter.
    const originalRequired = TIPS.map((t) => t.requiredAgents);
    TIPS.forEach((t) => {
      t.requiredAgents = ["claude"];
    });
    try {
      const { container } = render(<RotatingTip />);
      setHydrated();
      expect(container.firstChild).toBeNull();
    } finally {
      TIPS.forEach((t, i) => {
        t.requiredAgents = originalRequired[i];
      });
    }
  });

  it("uses shortcutActionId for the count lookup (worktree-overview path)", () => {
    // The worktree-overview tip dispatches "worktree.overview" via keyboard but
    // has actionId "worktree.overview.open" for label clicks. Counts from kbd
    // usage land under "worktree.overview", and the bias must respect that.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const counts: Record<string, number> = {};
    // Saturate every tip's lookup key (shortcutActionId ?? actionId) except
    // quick-switcher so we can confirm the chosen tip is quick-switcher.
    for (const tip of TIPS) {
      const key = tip.shortcutActionId ?? tip.actionId;
      if (key && key !== "nav.quickSwitcher") {
        counts[key] = 999;
      }
    }
    const { container } = render(<RotatingTip />);
    setHydrated(counts);
    expect(container.querySelector("button")?.textContent).toBe(labelFor("nav.quickSwitcher"));
  });

  it("clicking the action label dispatches the tip's actionId", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const counts: Record<string, number> = {};
    for (const tip of TIPS) {
      const key = tip.shortcutActionId ?? tip.actionId;
      if (key && key !== "nav.quickSwitcher") {
        counts[key] = 999;
      }
    }
    const { container } = render(<RotatingTip />);
    setHydrated(counts);
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(dispatch).toHaveBeenCalledWith("nav.quickSwitcher", undefined, { source: "user" });
  });
});

describe("contentGridTips module — no module-level mutable counter (#6756, #4754)", () => {
  it("does not declare a module-level mount counter", async () => {
    const { readFile } = await import("fs/promises");
    const { resolve } = await import("path");
    const source = await readFile(resolve(__dirname, "../contentGridTips.tsx"), "utf-8");
    expect(source).not.toMatch(/let\s+tipMountCount\b/);
  });
});
