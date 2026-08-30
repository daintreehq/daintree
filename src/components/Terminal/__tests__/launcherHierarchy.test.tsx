// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";
import { reduceMotionSelectors } from "./launcherMotionContract";

/**
 * The composition contracts behind issue #11987.
 *
 * Every assertion here states a RULE — "the anchor precedes anything
 * conditional", "the column has one measure", "nothing takes focus on mount" —
 * rather than a class string or a pixel. The surface these govern is expected
 * to keep changing; the rules are what must survive it.
 */

const h = vi.hoisted(() => ({
  panelIds: [] as string[],
  panelsById: {} as Record<string, unknown>,
  recipes: { currentProjectId: "p1" as string | null, isLoading: false },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve({ ok: true })) },
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: (sel: (s: typeof h) => unknown) => sel(h),
}));
vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: (sel: (s: typeof h.recipes) => unknown) => sel(h.recipes),
}));
vi.mock("@/hooks/app/useHomeDir", () => ({ useHomeDir: () => ({ homeDir: "/home/user" }) }));

// The bands are stubbed to identifiable markers: this suite is about the ORDER
// and the focus behaviour of the column, and each child owns its own suite.
vi.mock("../LauncherQuickActions", () => ({
  LauncherQuickActions: () => <div data-testid="band-launcher" />,
}));
vi.mock("../RecipeRunner/RecipeRunner", () => ({
  RecipeRunner: () => <div data-testid="band-recipes" />,
}));
vi.mock("../ResumeSessionLine", () => ({
  ResumeSessionLine: () => <div data-testid="band-resume" />,
}));
vi.mock("@/components/Pulse", () => ({
  ProjectPulseStrip: () => <div data-testid="band-pulse" />,
}));
vi.mock("../contentGridTips", () => ({ RotatingTip: () => <div data-testid="band-tip" /> }));

import { ContentGridEmptyState } from "../ContentGridEmptyState";

const EMPTY_STATE_PATH = resolve(__dirname, "../ContentGridEmptyState.tsx");
const LAUNCHER_DIR = resolve(__dirname, "..");

function renderLauncher(overrides: Record<string, unknown> = {}) {
  return render(
    <ContentGridEmptyState
      hasLaunchTarget
      hasProjectContext
      hasWorktrees
      isWorktreeInitialized
      activeWorktreeId="wt1"
      activeWorktreeBranch="main"
      activeWorktreePath="/home/user/proj"
      workspaceName="Helios"
      showProjectPulse
      defaultCwd="/home/user/proj"
      {...overrides}
    />
  );
}

/** Document order of the rendered band markers, top to bottom. */
function bandOrder(): string[] {
  const markers = Array.from(document.querySelectorAll<HTMLElement>("[data-testid^='band-']")).map(
    (el) => el.dataset.testid!
  );
  return markers;
}

describe("launcher column — the launch anchor is invariant (#11987)", () => {
  beforeEach(() => {
    h.panelIds = [];
    h.panelsById = {};
    h.recipes = { currentProjectId: "p1", isLoading: false };
  });

  it("puts the launch anchor ahead of every conditionally-rendered band", () => {
    h.panelIds = ["a"];
    h.panelsById = { a: { id: "a", kind: "terminal", launchAgentId: "claude" } };
    renderLauncher();
    const order = bandOrder();
    const anchor = order.indexOf("band-launcher");
    expect(anchor).toBeGreaterThanOrEqual(0);
    // Recipes, resume, pulse and the tip each appear or vanish with state the
    // user did not choose. Any one of them above the anchor makes the anchor's
    // position a function of that state.
    for (const conditional of ["band-recipes", "band-resume", "band-pulse", "band-tip"]) {
      expect(order.indexOf(conditional)).toBeGreaterThan(anchor);
    }
  });

  it("keeps the anchor at the same band index whichever conditional bands render", () => {
    const indices = new Set<number>();
    for (const state of [
      { recipes: { currentProjectId: "p1", isLoading: false }, pulse: true, agent: true },
      { recipes: { currentProjectId: null, isLoading: false }, pulse: true, agent: true },
      { recipes: { currentProjectId: "p1", isLoading: true }, pulse: false, agent: false },
      { recipes: { currentProjectId: null, isLoading: true }, pulse: false, agent: false },
    ]) {
      h.recipes = state.recipes;
      h.panelIds = state.agent ? ["a"] : [];
      h.panelsById = state.agent
        ? { a: { id: "a", kind: "terminal", launchAgentId: "claude" } }
        : {};
      const { unmount } = renderLauncher({ showProjectPulse: state.pulse });
      indices.add(bandOrder().indexOf("band-launcher"));
      unmount();
    }
    // One index across every permutation: the anchor is always the first band
    // after identity, never the second or third depending on what resolved.
    expect([...indices]).toEqual([0]);
  });

  it("does not move focus when it mounts", () => {
    h.panelIds = ["a"];
    h.panelsById = { a: { id: "a", kind: "terminal", launchAgentId: "claude" } };
    renderLauncher();
    // The user reaches this surface by closing their last panel or switching
    // worktree — never by asking for it. Anything here that grabs the caret
    // takes it from whatever they were actually doing.
    expect(document.activeElement).toBe(document.body);
  });

  it("names the surface as a region so it is not an anonymous run of buttons", () => {
    renderLauncher();
    expect(screen.getByRole("region", { name: /Helios/ })).toBeTruthy();
  });
});

describe("launcher column — one measure, owned by the parent", () => {
  const CHILDREN = [
    "LauncherQuickActions.tsx",
    "ResumeSessionLine.tsx",
    "RecipeRunner/RecipeRunner.tsx",
    "RecipeRunner/RecipeRunnerEmpty.tsx",
  ];

  it("caps the column's width in exactly one place", () => {
    const parent = readFileSync(EMPTY_STATE_PATH, "utf-8");
    // The parent declares the measure...
    expect(parent).toMatch(/const LAUNCHER_MEASURE = "max-w-\[[^"]+\]"/);
  });

  it("leaves every band's width to the parent", () => {
    for (const child of CHILDREN) {
      const source = readFileSync(resolve(LAUNCHER_DIR, child), "utf-8");
      // ...and no band re-declares one, which is what produced four different
      // content widths stacked down one centred column.
      // className attributes only — a `max-w-*` named in a comment is prose,
      // not a rule, and flagging it would make the contract unwritable.
      const ownMeasure = [...source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
        .flatMap((m) => (m[1] ?? m[2] ?? "").split(/\s+/))
        // Absolute caps only. A percentage cap (`max-w-[55%]` on a truncating
        // span) is a share of whatever the parent granted, so it cannot
        // introduce a second measure — an absolute one can and did.
        .filter((c) => /^(?:[a-z-]+:)*max-w-/.test(c) && !/%\]$/.test(c) && !c.endsWith("full"));
      expect(ownMeasure, `${child} sets its own width`).toEqual([]);
    }
  });
});

describe("launcher column — the anchor holds its position", () => {
  it("never centres the stack, so the anchor's offset cannot follow its height", () => {
    const source = readFileSync(EMPTY_STATE_PATH, "utf-8");
    const scroller = source.slice(source.indexOf("overflow-y-auto"));
    // Two failure modes, one rule. `justify-content: center` distributes
    // overflow to BOTH ends, so a column taller than the canvas loses its
    // first rows with no way to scroll back. `my-auto` fixes that but ties the
    // anchor's offset to the stack's HEIGHT, so it slides as conditional bands
    // resolve. Neither may come back: the offset above the column has to be
    // independent of everything below it.
    expect(scroller).not.toMatch(/flex min-h-full flex-col items-center justify-center/);
    expect(scroller).not.toMatch(/@container\/launcher[^"]*\bmy-auto\b/);
  });

  it("holds the column with a fixed top gutter that can still collapse", () => {
    const source = readFileSync(EMPTY_STATE_PATH, "utf-8");
    // A fixed basis keeps the offset constant whatever renders below it, and
    // `shrink` lets it collapse to zero when the column outgrows the canvas so
    // the first rows stay reachable.
    const gutter = /aria-hidden="true" className="w-full shrink basis-\d+"/;
    expect(source).toMatch(gutter);
    const gutterClass = gutter.exec(source)![0];
    expect(gutterClass).not.toContain("shrink-0");
    // …and all the slack goes below, so nothing pushes the column back down.
    expect(source).toMatch(/aria-hidden="true" className="w-full grow basis-0"/);
  });
});

describe("launcher column — every entry animation is suppressible", () => {
  it("registers each animated band with the in-app reduce-motion block", () => {
    const suppressed = reduceMotionSelectors();
    const sources = [EMPTY_STATE_PATH, resolve(LAUNCHER_DIR, "contentGridTips.tsx")];
    for (const path of sources) {
      const source = readFileSync(path, "utf-8");
      // `motion-safe:` only reads the OS preference. Daintree's own
      // "reduce animations" toggle is a body attribute no Tailwind variant can
      // reach, so an animated element is suppressible if and only if one of its
      // class names is named in the `@variant reduce-motion` block.
      for (const match of source.matchAll(/className="([^"]*animate-in[^"]*)"/g)) {
        const classes = (match[1] ?? "").split(/\s+/);
        expect(
          classes.some((c) => suppressed.has(c)),
          `${path}: an animate-in element carries no reduce-motion marker`
        ).toBe(true);
      }
    }
  });

  it("never feeds a keyframe animation through the transition utilities", () => {
    const sources = [EMPTY_STATE_PATH, resolve(LAUNCHER_DIR, "contentGridTips.tsx")];
    for (const path of sources) {
      const source = readFileSync(path, "utf-8");
      for (const match of source.matchAll(/className="([^"]*animate-in[^"]*)"/g)) {
        // Tailwind core's `duration-*`/`delay-*` win over the animation
        // library's same-named utilities and compile to `transition-duration` /
        // `transition-delay`, which a @keyframes animation never reads — and,
        // with no `transition-property` set, land on CSS's `all` default.
        // See `.lessons/11180.md`.
        const offenders = (match[1] ?? "")
          .split(/\s+/)
          .filter((c) => /^(?:[a-z-]+:)*(?:duration|delay)-/.test(c));
        expect(offenders, `${path}: ${offenders.join(", ")}`).toEqual([]);
      }
    }
  });
});

describe("tip catalog — sentence case", () => {
  it("gives every tip action a sentence-case label", () => {
    // Read from source rather than importing: this suite mocks the tip module
    // so it can assert band order without a live tip catalog.
    const source = readFileSync(resolve(LAUNCHER_DIR, "contentGridTips.tsx"), "utf-8");
    const labels = [...source.matchAll(/actionLabel:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      // Sentence case per CLAUDE.md's microcopy rule: one leading capital, and
      // no capitalised word after it (no product name appears in these today).
      expect(label, label).not.toMatch(/\s[A-Z]/);
    }
  });
});

describe("launcher column — composite widgets are one tab stop", () => {
  it("gives the quick-launch cluster a single tab stop", () => {
    const source = readFileSync(resolve(LAUNCHER_DIR, "LauncherQuickActions.tsx"), "utf-8");
    // The pinned agent set is uncapped by design, so without a roving stop the
    // number of Tab presses between the user and the rest of the surface is a
    // number the user chose in a settings dialog months ago.
    expect(source).toContain('role="toolbar"');
    expect(source).toMatch(/tabIndex=\{index === activeChip \? 0 : -1\}/);
  });

  it("gives the recipe listbox a single tab stop", () => {
    const source = readFileSync(
      resolve(LAUNCHER_DIR, "RecipeRunner/RecipeRunnerList.tsx"),
      "utf-8"
    );
    // The combobox owns the stop; every option, Create included, is reached
    // with the arrow keys and named through aria-activedescendant.
    expect(source).toContain("aria-activedescendant");
    const optionStops = source.match(/tabIndex=\{-1\}/g) ?? [];
    expect(optionStops.length).toBeGreaterThanOrEqual(2);
  });
});

describe("launcher column — teaching never reads as an action", () => {
  it("exempts the tip's control from the button borders in BOTH contrast modes", () => {
    const css = readFileSync(resolve(LAUNCHER_DIR, "../../index.css"), "utf-8");
    // macOS fires only `prefers-contrast: more`; Windows swaps in system
    // colours via `forced-colors: active`. The blocks are separate on purpose,
    // so the exemption has to exist in each of them independently — a single
    // shared rule would silently cover only one platform.
    for (const marker of ["@media (forced-colors: active)", "@media (prefers-contrast: more)"]) {
      const start = css.indexOf(marker);
      expect(start, `${marker} block is missing`).toBeGreaterThan(-1);
      let depth = 0;
      let end = css.indexOf("{", start);
      for (let i = end; i < css.length; i++) {
        if (css[i] === "{") depth++;
        if (css[i] === "}" && --depth === 0) {
          end = i;
          break;
        }
      }
      expect(css.slice(start, end), `${marker} does not exempt .tip-action`).toContain(
        ".tip-action"
      );
    }
    const tips = readFileSync(resolve(LAUNCHER_DIR, "contentGridTips.tsx"), "utf-8");
    expect(tips).toContain("tip-action");
  });
});
