// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { reduceMotionSelectors } from "./launcherMotionContract";

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

// The launcher column and the project-only strips are covered by their own
// suites; here they only need to be identifiable in the tree.
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
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { ReactNode } from "react";

// The app root supplies the TooltipProvider. Triggers render inline; the
// content is left out so a disclosed label is not counted twice.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

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

// A scratch is an active workspace with no worktree, branch, recipes or project
// settings — the launcher must still be reachable (#11076).
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

// `isPtyPanel` treats a missing kind as "terminal"; hasEverLaunchedAgent then
// keys off the launch/detected agent fields.
const markLaunchedAnAgent = () => {
  h.panelIds = ["p1"];
  h.panelsById = { p1: { kind: "terminal", launchAgentId: "claude" } };
};

describe("ContentGridEmptyState — workspace capabilities", () => {
  beforeEach(() => {
    h.panelIds = [];
    h.panelsById = {};
    h.recipes.currentProjectId = null;
    h.recipes.isLoading = false;
    h.dispatch.mockClear();
  });

  describe("an active scratch", () => {
    it("offers the launcher instead of leaving the canvas empty", () => {
      render(<ContentGridEmptyState {...SCRATCH_PROPS} />);

      expect(screen.getByTestId("launcher-quick-actions")).toBeTruthy();
    });

    it("shows the scratch's own name and path", () => {
      render(<ContentGridEmptyState {...SCRATCH_PROPS} />);

      expect(screen.getByText(SCRATCH_PROPS.workspaceName)).toBeTruthy();
      expect(screen.getByText(SCRATCH_PROPS.activeWorktreePath)).toBeTruthy();
    });

    it("hides project settings — a scratch has no settings tab to open", () => {
      render(<ContentGridEmptyState {...SCRATCH_PROPS} />);

      expect(screen.queryByLabelText("Project settings")).toBeNull();
    });

    it("withholds the tip catalog, which only speaks of worktrees and project files", () => {
      markLaunchedAnAgent();

      render(<ContentGridEmptyState {...SCRATCH_PROPS} />);

      expect(screen.queryByTestId("rotating-tip")).toBeNull();
    });

    it("suppresses the project pulse", () => {
      render(<ContentGridEmptyState {...SCRATCH_PROPS} />);

      expect(screen.queryByTestId("project-pulse")).toBeNull();
    });

    it("does not offer to open a folder — the user already has a workspace", () => {
      render(<ContentGridEmptyState {...SCRATCH_PROPS} />);

      expect(screen.queryByRole("button", { name: /open project/i })).toBeNull();
    });

    it("suppresses recipes, which are project-scoped", () => {
      render(<ContentGridEmptyState {...SCRATCH_PROPS} />);

      expect(screen.queryByTestId("recipe-runner")).toBeNull();
    });
  });

  describe("an active project", () => {
    it("keeps its settings affordance", () => {
      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      expect(screen.getByLabelText("Project settings")).toBeTruthy();
    });

    it("keeps its tips once an agent has been launched", () => {
      markLaunchedAnAgent();

      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      expect(screen.getByTestId("rotating-tip")).toBeTruthy();
    });

    // Issue #6752 — first-run users shouldn't get shortcut-carousel teaching
    // content before they've launched anything.
    it("withholds tips until the first agent launch", () => {
      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      expect(screen.queryByTestId("rotating-tip")).toBeNull();
    });

    it("shows recipes once the recipe store has settled on the project", () => {
      h.recipes.currentProjectId = "project-1";

      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      expect(screen.getByTestId("recipe-runner")).toBeTruthy();
    });

    // The CLAUDE.md recipe-gating gotcha: `loadRecipes()` sets currentProjectId
    // synchronously before the IPC resolves, so an unsettled store must stay
    // quiet rather than flash the "create your first recipe" empty state.
    it("withholds recipes while the recipe store is still loading", () => {
      h.recipes.currentProjectId = "project-1";
      h.recipes.isLoading = true;

      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      expect(screen.queryByTestId("recipe-runner")).toBeNull();
    });

    // Isolates the project-binding conjunct: a settled store that hasn't bound a
    // project yet must stay quiet even in full project context, or the cold-start
    // flash returns.
    it("withholds recipes until the store has bound a project", () => {
      h.recipes.currentProjectId = null;
      h.recipes.isLoading = false;

      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      expect(screen.queryByTestId("recipe-runner")).toBeNull();
    });

    it("shows the project pulse", () => {
      render(<ContentGridEmptyState {...PROJECT_PROPS} />);

      expect(screen.getByTestId("project-pulse")).toBeTruthy();
    });

    it("honours the user's pulse hide toggle", () => {
      render(<ContentGridEmptyState {...PROJECT_PROPS} showProjectPulse={false} />);

      expect(screen.queryByTestId("project-pulse")).toBeNull();
    });
  });

  // The launcher arrives as a sequence of sections rather than one flat block.
  // These assert the structural rules the stagger depends on, not the utilities
  // themselves — a class name copied out of the component would be a tautology,
  // but "every delayed section fills backwards" is a real invariant: the
  // underlying `enter` animation defaults to `fill-mode: none`, which paints a
  // delayed section fully visible for the length of its delay and then snaps it
  // hidden before fading it in.
  describe("entry stagger", () => {
    // Utilities that animate. Each must be gated on `motion-safe:` so the OS
    // reduced-motion preference suppresses it.
    const MOTION_UTILITY =
      /(^|:)(animate-in|fade-in|slide-in-from-[a-z]+-\d+|fill-mode-[a-z]+|\[--tw-animation-(delay|duration):\d+ms\])$/;

    const classesOf = (el: Element) => el.className.split(/\s+/).filter(Boolean);

    // The ladder rides `--tw-animation-delay` rather than `delay-*`, because
    // Tailwind's `delay-*` compiles to `transition-delay` — which a keyframe
    // animation never reads. Parsing the property (not a `delay-N` class name)
    // is what keeps this suite honest: a regression back to `delay-*` reads as
    // "no delay at all" here, which is exactly what it would be on screen.
    const delayOf = (el: Element) => {
      const token = classesOf(el).find((c) => /\[--tw-animation-delay:\d+ms\]$/.test(c));
      const ms = token?.match(/(\d+)ms/);
      return ms ? Number(ms[1]) : 0;
    };

    /** Every section carrying an entry animation, in DOM order. */
    const animatedSections = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('[class*="animate-in"]'));

    // Every gate satisfied, so all six sections render at once.
    const renderWholeLauncher = () => {
      markLaunchedAnAgent();
      h.recipes.currentProjectId = "project-1";
      return render(<ContentGridEmptyState {...PROJECT_PROPS} />).container;
    };

    it("animates each launcher section rather than the container as one block", () => {
      const container = renderWholeLauncher();

      // The whole point of the issue: the launcher must not arrive as one flat
      // block, so its root carries no entry animation of its own…
      for (const root of Array.from(container.children)) {
        expect(classesOf(root).some((c) => /(^|:)animate-in$/.test(c))).toBe(false);
      }
      // …and every section that renders arrives on its own: hero, recipes,
      // resume, quick actions, pulse, tip.
      expect(animatedSections(container)).toHaveLength(6);
    });

    it("staggers the sections by a single uniform step, in DOM order", () => {
      const container = renderWholeLauncher();

      const delays = animatedSections(container).map(delayOf);
      const steps = delays.slice(1).map((delay, i) => delay - (delays[i] ?? 0));

      // The head of the ladder carries no delay, each step is forward, and the
      // cadence never varies — without asserting the step's literal size.
      expect(delays[0]).toBe(0);
      expect(steps.every((step) => step > 0)).toBe(true);
      expect(new Set(steps).size).toBe(1);
    });

    it("fills backwards on every delayed section, so none flashes before its turn", () => {
      const container = renderWholeLauncher();

      for (const section of animatedSections(container)) {
        if (delayOf(section) === 0) continue;
        expect(classesOf(section).some((c) => /(^|:)fill-mode-backwards$/.test(c))).toBe(true);
      }
    });

    // `duration-*` and `delay-*` compile to `transition-duration` /
    // `transition-delay`, which a keyframe animation never reads — so they
    // cannot drive this stagger. Worse, these wrappers declare no
    // `transition-property`, so either one would land on CSS's `all` default
    // and silently give every section an every-property transition. The entry
    // rides the animation's own custom properties instead.
    it("drives the entry from the animation, never leaking into the transition system", () => {
      const container = renderWholeLauncher();

      for (const section of animatedSections(container)) {
        const transitionUtilities = classesOf(section).filter((c) =>
          /(^|:)(duration|delay)-/.test(c)
        );
        expect(transitionUtilities).toEqual([]);
      }
    });

    it("gates every animating utility on motion-safe, so the OS preference suppresses it", () => {
      const container = renderWholeLauncher();

      for (const section of animatedSections(container)) {
        const motionUtilities = classesOf(section).filter((c) => MOTION_UTILITY.test(c));

        expect(motionUtilities.length).toBeGreaterThan(0);
        for (const utility of motionUtilities) {
          expect(utility.startsWith("motion-safe:")).toBe(true);
        }
      }
    });

    // `motion-safe:` only sees the OS preference. Daintree's own
    // reduce-animations toggle is a `body` attribute, and the only thing that
    // reads it is the `@variant reduce-motion` block in index.css — so a
    // section is suppressible by that toggle if, and only if, one of its
    // classes is named in that block. This asserts the wiring between the
    // component and the stylesheet, which nothing else would catch.
    it("registers every animated section with the in-app reduce-animations kill switch", () => {
      const suppressed = reduceMotionSelectors();
      expect(suppressed.size).toBeGreaterThan(0);

      const container = renderWholeLauncher();

      for (const section of animatedSections(container)) {
        const covered = classesOf(section).filter((c) => suppressed.has(c));
        expect(covered.length).toBeGreaterThan(0);
      }
    });
  });

  describe("no launch target", () => {
    // Every launcher-column element hangs off `hasLaunchTarget`. Without this,
    // the fixtures correlate the conjuncts and dropping that gate from any one
    // of them would go unnoticed.
    it("withholds recipes, tips and the pulse even when their own conditions are met", () => {
      markLaunchedAnAgent();
      h.recipes.currentProjectId = "project-1";

      render(<ContentGridEmptyState {...PROJECT_PROPS} hasLaunchTarget={false} />);

      expect(screen.queryByTestId("recipe-runner")).toBeNull();
      expect(screen.queryByTestId("rotating-tip")).toBeNull();
      expect(screen.queryByTestId("project-pulse")).toBeNull();
      expect(screen.queryByTestId("resume-session-line")).toBeNull();
    });

    it("withholds the launcher and the identity hero when there is nowhere to launch into", () => {
      render(
        <ContentGridEmptyState
          hasLaunchTarget={false}
          hasProjectContext
          hasWorktrees
          isWorktreeInitialized
          workspaceName="My project"
          showProjectPulse={false}
        />
      );

      expect(screen.queryByTestId("launcher-quick-actions")).toBeNull();
      expect(screen.queryByText("My project")).toBeNull();
      expect(screen.getByText("Select a worktree")).toBeTruthy();
    });

    it("offers to open a folder when the project has no worktrees at all", () => {
      render(
        <ContentGridEmptyState
          hasLaunchTarget={false}
          hasProjectContext
          hasWorktrees={false}
          isWorktreeInitialized
          showProjectPulse={false}
        />
      );

      expect(screen.getByText("Open a project folder")).toBeTruthy();
      expect(screen.queryByText("Select a worktree")).toBeNull();
    });

    it("dispatches the add-project action from the open-folder button", () => {
      render(
        <ContentGridEmptyState
          hasLaunchTarget={false}
          hasProjectContext
          hasWorktrees={false}
          isWorktreeInitialized
          showProjectPulse={false}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /open project/i }));

      expect(h.dispatch).toHaveBeenCalledWith("project.add", undefined, { source: "user" });
    });

    // Issue #8645 — before the worktree snapshot lands, either copy variant would
    // be a guess, so the canvas stays silent rather than flashing the wrong one.
    // Both branches are checked: `hasWorktrees` alone must not decide it.
    it.each([true, false])(
      "stays silent until the worktree snapshot has initialized (hasWorktrees=%s)",
      (hasWorktrees) => {
        render(
          <ContentGridEmptyState
            hasLaunchTarget={false}
            hasProjectContext
            hasWorktrees={hasWorktrees}
            isWorktreeInitialized={false}
            showProjectPulse={false}
          />
        );

        expect(screen.queryByText("Open a project folder")).toBeNull();
        expect(screen.queryByText("Select a worktree")).toBeNull();
      }
    );
  });

  describe("an active deleted worktree", () => {
    beforeEach(() => {
      useWorktreeSelectionStore.getState().reset();
      useWorktreeSelectionStore.getState().addDeletedWorktree({
        id: "ghost-1",
        title: "feature/gone",
        path: "/repo-worktrees/gone",
        deletedAt: 1000,
        expiresAt: null,
        holdReason: null,
        pinnedBeforeWorktreeId: null,
      });
      useWorktreeSelectionStore.setState({ activeWorktreeId: "ghost-1" });
    });

    afterEach(() => {
      useWorktreeSelectionStore.getState().reset();
    });

    it("names the deleted worktree instead of claiming nothing is selected", () => {
      render(
        <ContentGridEmptyState
          hasLaunchTarget={false}
          hasProjectContext
          hasWorktrees
          isWorktreeInitialized
          showProjectPulse={false}
        />
      );

      expect(screen.getByText("Worktree deleted")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Go to main worktree" })).toBeTruthy();
      expect(screen.queryByText("Select a worktree")).toBeNull();
    });
  });
});

describe("ContentGridEmptyState — replaying the entry on project reveal (issue #11209)", () => {
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
  let originalOffsetWidth: PropertyDescriptor | undefined;

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
    originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
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
    if (originalOffsetWidth) {
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
    }
    document.body.removeAttribute("data-reduce-animations");
    document.body.removeAttribute("data-performance-mode");
    vi.unstubAllGlobals();
  });

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
