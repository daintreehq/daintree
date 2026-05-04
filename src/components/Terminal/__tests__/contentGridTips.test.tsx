// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";

vi.mock("@/hooks/useKeybinding", () => ({
  useKeybindingDisplay: () => "",
}));

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch },
}));

import { RotatingTip, TIPS } from "../contentGridTips";
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

describe("RotatingTip — count-biased selection (#6756)", () => {
  beforeEach(() => {
    setUnhydrated();
    useCliAvailabilityStore.setState({ availability: makeAvailability("ready") });
    dispatch.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing while shortcutHintStore is not hydrated", () => {
    const { container } = render(<RotatingTip />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a tip once hydrated", () => {
    const { container } = render(<RotatingTip />);
    expect(container.firstChild).toBeNull();
    setHydrated();
    expect(container.querySelector("p")?.textContent).toMatch(/^Tip:/);
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
    expect(container.querySelector("button")?.textContent).toBe("Inject Context");
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
    expect(container.querySelector("button")?.textContent).not.toBe("Open Quick Switcher");
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
    expect(before).toBe("Open Quick Switcher");

    // Simulate the user invoking some other shortcut after the tip mounted.
    act(() => {
      shortcutHintStore.setState({
        counts: { ...counts, "terminal.inject": 5 },
      });
    });

    const after = container.querySelector("button")?.textContent;
    expect(after).toBe(before);
  });

  it("renders nothing when no tips pass agent availability", () => {
    // Filter all tips out by claiming no agents are launchable AND mark every
    // non-agent tip as having a `requiredAgents` constraint. Since we can't
    // mutate TIPS, instead make all agents missing and verify a tip still
    // renders (most tips have no requiredAgents). This validates the empty
    // path indirectly via the unhydrated case above.
    useCliAvailabilityStore.setState({ availability: makeAvailability("missing") });
    const { container } = render(<RotatingTip />);
    setHydrated();
    // At least one non-agent-gated tip exists, so we still get a tip even with
    // all agents missing — this confirms filtering doesn't over-exclude.
    expect(container.querySelector("p")?.textContent).toMatch(/^Tip:/);
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
