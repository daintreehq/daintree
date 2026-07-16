// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

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
 * A stand-in for a running CSS animation. jsdom implements no part of the Web
 * Animations API, so the launcher's real entry has no timeline here — what these
 * tests can prove is the orchestration around it: which elements are restarted,
 * when, and whether a suppressor stops it. The restart itself (that cancel/play
 * replays the ladder rather than collapsing it) is browser behaviour, verified
 * against Chromium rather than asserted here.
 */
const makeAnimation = (log: string[], label: string) => ({
  cancel: vi.fn(() => log.push(`${label}:cancel`)),
  play: vi.fn(() => log.push(`${label}:play`)),
});
type FakeAnimation = ReturnType<typeof makeAnimation>;

const animationsByElement = new Map<Element, FakeAnimation[]>();
let queriedElements: Element[] = [];

/** Frames run only when a test says so, so "not yet" is observable. */
const pendingFrames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;

const flushFrame = () => {
  const due = [...pendingFrames.values()];
  pendingFrames.clear();
  act(() => {
    for (const cb of due) cb(0);
  });
};

let revealCallbacks: (() => void)[] = [];
let cachedCallbacks: (() => void)[] = [];
const offReveal = vi.fn();
const offCached = vi.fn();

const reveal = () => {
  for (const cb of revealCallbacks) cb();
};
const parkInCache = () => {
  for (const cb of cachedCallbacks) cb();
};

/** Both frames of the reveal's double-rAF wait. */
const settleReveal = () => {
  reveal();
  flushFrame();
  flushFrame();
};

const sectionsIn = (container: HTMLElement): Element[] =>
  [...container.querySelectorAll("div")].filter((el) =>
    el.className.includes("launcher-section-enter")
  );

/** Give every launcher section one animation to restart; returns the log. */
const armSections = (container: HTMLElement): { log: string[]; sections: Element[] } => {
  const log: string[] = [];
  const sections = sectionsIn(container);
  sections.forEach((section, i) => {
    animationsByElement.set(section, [makeAnimation(log, `section-${i}`)]);
  });
  return { log, sections };
};

beforeEach(() => {
  h.panelIds = ["p1"];
  h.panelsById = { p1: { kind: "terminal", launchAgentId: "claude" } };
  h.recipes.currentProjectId = "proj-1";
  h.recipes.isLoading = false;
  h.dispatch.mockClear();

  animationsByElement.clear();
  queriedElements = [];
  pendingFrames.clear();
  nextFrameId = 0;
  revealCallbacks = [];
  cachedCallbacks = [];
  offReveal.mockClear();
  offCached.mockClear();

  // Models the real contract rather than returning a flat list: `subtree` is the
  // difference between restarting the six sections and restarting every animation
  // underneath them, so a stub blind to it would pass either way.
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    writable: true,
    value: function (this: Element, options?: { subtree?: boolean }) {
      queriedElements.push(this);
      const own = animationsByElement.get(this) ?? [];
      if (!options?.subtree) return own;
      const descendants = [...this.querySelectorAll("*")].flatMap(
        (el) => animationsByElement.get(el) ?? []
      );
      return [...own, ...descendants];
    },
  });

  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    const id = ++nextFrameId;
    pendingFrames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    pendingFrames.delete(id);
  });

  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));

  vi.stubGlobal("electron", {
    app: {
      onViewRevealed: (cb: () => void) => {
        revealCallbacks.push(cb);
        return offReveal;
      },
      onViewCached: (cb: () => void) => {
        cachedCallbacks.push(cb);
        return offCached;
      },
    },
  });
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Partial<Element>).getAnimations;
  document.body.removeAttribute("data-reduce-animations");
  document.body.removeAttribute("data-performance-mode");
  vi.unstubAllGlobals();
});

describe("ContentGridEmptyState — replaying the entry on project reveal (issue #11209)", () => {
  it("restarts every launcher section's entry when the view is revealed", () => {
    const { container } = render(<ContentGridEmptyState {...PROJECT_PROPS} />);
    const { log, sections } = armSections(container);
    expect(sections.length).toBeGreaterThan(1);

    settleReveal();

    // Each section replays, and cancel precedes play — the order that reapplies
    // the pre-entry state instead of restarting from wherever it left off.
    expect(log).toEqual(sections.flatMap((_, i) => [`section-${i}:cancel`, `section-${i}:play`]));
  });

  it("waits for the compositor to wake before restarting, rather than replaying into the reveal", () => {
    const { container } = render(<ContentGridEmptyState {...PROJECT_PROPS} />);
    const { log } = armSections(container);

    reveal();
    expect(log).toEqual([]);

    flushFrame();
    expect(log).toEqual([]);

    flushFrame();
    expect(log.length).toBeGreaterThan(0);
  });

  it("leaves motion owned by the sections' descendants on its own timeline", () => {
    const { container } = render(<ContentGridEmptyState {...PROJECT_PROPS} />);
    const { log } = armSections(container);

    // The tip rotates inside a section; a subtree-wide restart would reset it.
    const descendantLog: string[] = [];
    const tip = screen.getByTestId("rotating-tip");
    animationsByElement.set(tip, [makeAnimation(descendantLog, "tip")]);

    settleReveal();

    expect(log.length).toBeGreaterThan(0);
    expect(descendantLog).toEqual([]);
    expect(queriedElements).not.toContain(tip);
  });

  it("replays for a scratch, which reaches the launcher through the same reveal", () => {
    const { container } = render(<ContentGridEmptyState {...SCRATCH_PROPS} />);
    const { log } = armSections(container);

    settleReveal();

    expect(log.length).toBeGreaterThan(0);
  });

  it("collapses a reveal arriving mid-schedule into one replay", () => {
    const { container } = render(<ContentGridEmptyState {...PROJECT_PROPS} />);
    const { log, sections } = armSections(container);

    reveal();
    flushFrame();
    reveal(); // Supersedes the first, which is still a frame from restarting.
    flushFrame();
    flushFrame();

    expect(log).toEqual(sections.flatMap((_, i) => [`section-${i}:cancel`, `section-${i}:play`]));
  });

  it("drops a replay for a view parked back in the cache before it could run", () => {
    const { container } = render(<ContentGridEmptyState {...PROJECT_PROPS} />);
    const { log } = armSections(container);

    reveal();
    parkInCache();
    flushFrame();
    flushFrame();

    expect(log).toEqual([]);
  });

  it("unsubscribes and abandons a pending replay on unmount", () => {
    const { container, unmount } = render(<ContentGridEmptyState {...PROJECT_PROPS} />);
    const { log } = armSections(container);

    reveal();
    unmount();
    flushFrame();
    flushFrame();

    expect(log).toEqual([]);
    expect(offReveal).toHaveBeenCalled();
    expect(offCached).toHaveBeenCalled();
  });

  describe("motion suppressors", () => {
    it("skips the replay under the OS reduced-motion preference", () => {
      vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
      const { container } = render(<ContentGridEmptyState {...PROJECT_PROPS} />);
      const { log } = armSections(container);

      settleReveal();

      expect(log).toEqual([]);
      expect(queriedElements).toEqual([]);
    });

    it("skips the replay under the in-app reduce-animations toggle", () => {
      document.body.setAttribute("data-reduce-animations", "true");
      const { container } = render(<ContentGridEmptyState {...PROJECT_PROPS} />);
      const { log } = armSections(container);

      settleReveal();

      expect(log).toEqual([]);
      expect(queriedElements).toEqual([]);
    });

    it("skips the replay under performance mode", () => {
      document.body.setAttribute("data-performance-mode", "true");
      const { container } = render(<ContentGridEmptyState {...PROJECT_PROPS} />);
      const { log } = armSections(container);

      settleReveal();

      expect(log).toEqual([]);
      expect(queriedElements).toEqual([]);
    });
  });
});
