// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Hoisted mutable state so each mock reads its slice at call time and a test can
// reshape the stores before rendering.
const h = vi.hoisted(() => ({
  panelIds: [] as string[],
  panelsById: {} as Record<string, unknown>,
  recipes: { currentProjectId: null as string | null, isLoading: false },
  dispatch: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: h.dispatch },
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: (sel: (s: typeof h) => unknown) => sel(h),
}));
vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: (sel: (s: typeof h.recipes) => unknown) => sel(h.recipes),
}));
vi.mock("@/hooks/app/useHomeDir", () => ({
  useHomeDir: () => ({ homeDir: "/home/user" }),
}));

vi.mock("../LauncherQuickActions", () => ({
  LauncherQuickActions: () => <div data-testid="launcher-quick-actions" />,
}));
vi.mock("../RecipeRunner/RecipeRunner", () => ({
  RecipeRunner: () => <div data-testid="recipe-runner" />,
}));
vi.mock("../ResumeSessionLine", () => ({
  ResumeSessionLine: () => <div data-testid="resume-session-line" />,
}));
vi.mock("../contentGridTips", () => ({
  RotatingTip: () => <div data-testid="rotating-tip" />,
}));
vi.mock("@/components/Pulse", () => ({
  ProjectPulseStrip: () => <div data-testid="project-pulse" />,
}));

import { ContentGridEmptyState } from "../ContentGridEmptyState";

const PROJECT_PROPS = {
  hasLaunchTarget: true,
  hasProjectContext: true,
  hasWorktrees: true,
  isWorktreeInitialized: true,
  activeWorktreeId: "wt-1",
  activeWorktreeName: "feature",
  activeWorktreeBranch: "feature/x",
  activeWorktreePath: "/repo-worktrees/feature",
  workspaceName: "My project",
  showProjectPulse: true,
} as const;

const SCRATCH_PROPS = {
  hasLaunchTarget: true,
  hasProjectContext: false,
  hasWorktrees: false,
  isWorktreeInitialized: false,
  workspaceName: "Scratch 2026-07-12 09:30",
  activeWorktreePath: "/scratches/abc-123",
  showProjectPulse: false,
  defaultCwd: "/scratches/abc-123",
} as const;

/**
 * A CSS animation only restarts if the teardown is flushed before the class is
 * handed the element back — two writes in one style resolution collapse into no
 * change at all. jsdom runs no style engine and never lays out, so what stands in
 * for "did it restart" is the sequence: a forced reflow observed while the
 * animation was overridden to `none`, and the override released afterwards.
 * Whether Chromium then replays the keyframes is browser behaviour, verified
 * against the real engine rather than asserted here.
 */
const reflowsWhileOverridden = new Map<Element, string>();

let revealCallbacks: (() => void)[] = [];
const offReveal = vi.fn();

const reveal = () => {
  for (const cb of revealCallbacks) cb();
};

const sectionsIn = (container: HTMLElement): HTMLElement[] =>
  [...container.querySelectorAll<HTMLElement>("div")].filter((el) =>
    el.className.includes("launcher-section-enter")
  );

beforeEach(() => {
  h.panelIds = ["p1"];
  h.panelsById = { p1: { kind: "terminal", launchAgentId: "claude" } };
  h.recipes.currentProjectId = "proj-1";
  h.recipes.isLoading = false;
  h.dispatch.mockClear();

  reflowsWhileOverridden.clear();
  revealCallbacks = [];
  offReveal.mockClear();

  // jsdom lays nothing out, so offsetWidth is an inert 0 and the reflow it is
  // meant to pin is unobservable. Recording the animation override in force when
  // it is read makes the ordering the restart depends on testable.
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      reflowsWhileOverridden.set(this, this.style.animationName);
      return 0;
    },
  });

  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));

  vi.stubGlobal("electron", {
    app: {
      onViewRevealed: (cb: () => void) => {
        revealCallbacks.push(cb);
        return offReveal;
      },
    },
  });
});

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as Partial<HTMLElement>).offsetWidth;
  document.body.removeAttribute("data-reduce-animations");
  document.body.removeAttribute("data-performance-mode");
  vi.unstubAllGlobals();
});

describe("ContentGridEmptyState — replaying the entry on project reveal (issue #11209)", () => {
  it("restarts every launcher section's entry when the view is revealed", () => {
    const { container } = render(<ContentGridEmptyState {...PROJECT_PROPS} />);
    const sections = sectionsIn(container);
    expect(sections.length).toBeGreaterThan(1);

    reveal();

    for (const section of sections) {
      // Torn down and flushed…
      expect(reflowsWhileOverridden.get(section)).toBe("none");
      // …then handed back to the class, which still owns the keyframes and the
      // section's rung on the delay ladder.
      expect(section.style.animationName).toBe("");
    }
  });

  it("replays on reveal rather than on render, which no switch changes", () => {
    render(<ContentGridEmptyState {...PROJECT_PROPS} />);

    expect(reflowsWhileOverridden.size).toBe(0);

    reveal();

    expect(reflowsWhileOverridden.size).toBeGreaterThan(0);
  });

  it("leaves motion owned by the sections' descendants on its own timeline", () => {
    render(<ContentGridEmptyState {...PROJECT_PROPS} />);
    // The tip rotates inside a section; restarting the subtree would reset it.
    const tip = screen.getByTestId("rotating-tip");

    reveal();

    expect(reflowsWhileOverridden.has(tip)).toBe(false);
    expect(tip.style.animationName).toBe("");
  });

  it("replays for a scratch, which reaches the launcher through the same reveal", () => {
    const { container } = render(<ContentGridEmptyState {...SCRATCH_PROPS} />);
    const sections = sectionsIn(container);
    expect(sections.length).toBeGreaterThan(0);

    reveal();

    for (const section of sections) {
      expect(reflowsWhileOverridden.get(section)).toBe("none");
    }
  });

  it("replays again on every subsequent reveal, not just the first", () => {
    const { container } = render(<ContentGridEmptyState {...PROJECT_PROPS} />);
    const [section] = sectionsIn(container);

    reveal();
    reflowsWhileOverridden.clear();
    reveal();

    expect(reflowsWhileOverridden.get(section!)).toBe("none");
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = render(<ContentGridEmptyState {...PROJECT_PROPS} />);

    unmount();

    expect(offReveal).toHaveBeenCalled();
  });

  it("survives a reveal with no launcher to replay", () => {
    render(
      <ContentGridEmptyState
        {...PROJECT_PROPS}
        hasLaunchTarget={false}
        isWorktreeInitialized={true}
      />
    );

    expect(() => reveal()).not.toThrow();
    expect(reflowsWhileOverridden.size).toBe(0);
  });

  describe("motion suppressors", () => {
    it("skips the replay under the OS reduced-motion preference", () => {
      vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      reveal();

      expect(reflowsWhileOverridden.size).toBe(0);
    });

    it("skips the replay under the in-app reduce-animations toggle", () => {
      document.body.setAttribute("data-reduce-animations", "true");
      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      reveal();

      expect(reflowsWhileOverridden.size).toBe(0);
    });

    it("skips the replay under performance mode", () => {
      document.body.setAttribute("data-performance-mode", "true");
      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      reveal();

      expect(reflowsWhileOverridden.size).toBe(0);
    });
  });
});
