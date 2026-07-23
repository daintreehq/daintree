// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DURATION_75,
  DURATION_100,
  DURATION_150,
  DURATION_200,
  DURATION_250,
  DURATION_300,
  DRAG_OVERLAY_SPRING_VISUAL_DURATION,
  DRAG_OVERLAY_SPRING_BOUNCE,
  EASE_OUT_EXPO,
  EASE_SNAPPY,
  EASE_SPRING_CRITICAL,
  getPanelTransitionDuration,
  getTerminalAnimationDuration,
  getUiAnimationDuration,
  getUiTransitionDuration,
  PANEL_MINIMIZE_DURATION,
  PANEL_MINIMIZE_EASING,
  PANEL_RESTORE_DURATION,
  PANEL_RESTORE_EASING,
  TERMINAL_ANIMATION_DURATION,
  UI_ANIMATION_DURATION,
  UI_DOHERTY_THRESHOLD,
  UI_PALETTE_STALE_DELAY,
  UI_SPIN_CYCLE_MS,
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
} from "../animationUtils";

describe("motion token constants", () => {
  it("exposes the 75–300ms duration scale", () => {
    expect(DURATION_75).toBe(75);
    expect(DURATION_100).toBe(100);
    expect(DURATION_150).toBe(150);
    expect(DURATION_200).toBe(200);
    expect(DURATION_250).toBe(250);
    expect(DURATION_300).toBe(300);
  });

  it("exposes semantic easing tokens as valid CSS strings", () => {
    expect(EASE_SNAPPY).toMatch(/^cubic-bezier\(/);
    expect(EASE_OUT_EXPO).toMatch(/^cubic-bezier\(/);
    expect(EASE_SPRING_CRITICAL).toMatch(/^linear\(/);
  });

  it("tunes the drag-overlay pickup spring in seconds with near-zero bounce", () => {
    // Framer Motion's `visualDuration` is in seconds, not ms — a value >= 1
    // would mean someone passed a millisecond figure and the pickup would crawl.
    expect(DRAG_OVERLAY_SPRING_VISUAL_DURATION).toBeGreaterThan(0);
    expect(DRAG_OVERLAY_SPRING_VISUAL_DURATION).toBeLessThan(1);
    // Near-zero bounce keeps the pickup crisp; visible overshoot reads cheap.
    expect(DRAG_OVERLAY_SPRING_BOUNCE).toBeGreaterThanOrEqual(0);
    expect(DRAG_OVERLAY_SPRING_BOUNCE).toBeLessThan(0.1);
  });
});

describe("getPanelTransitionDuration", () => {
  it("returns 120ms for minimize direction", () => {
    expect(getPanelTransitionDuration("minimize")).toBe(PANEL_MINIMIZE_DURATION);
    expect(getPanelTransitionDuration("minimize")).toBe(120);
  });

  it("returns 200ms for restore direction", () => {
    expect(getPanelTransitionDuration("restore")).toBe(PANEL_RESTORE_DURATION);
    expect(getPanelTransitionDuration("restore")).toBe(200);
  });

  it("ignores prefers-reduced-motion — CSS owns reduced-motion, not JS timers", () => {
    // WCAG 2.2 SC 2.3.3: remove motion via component-level @media overrides,
    // don't zero out the duration (that produces a spatial jump).
    const matchMediaSpy = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("matchMedia", matchMediaSpy);

    try {
      expect(getPanelTransitionDuration("minimize")).toBe(120);
      expect(getPanelTransitionDuration("restore")).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("getUiTransitionDuration", () => {
  let matchMediaSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    matchMediaSpy = vi.fn().mockReturnValue({ matches: false });
    vi.stubGlobal("matchMedia", matchMediaSpy);
    document.body.dataset.performanceMode = "false";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.body.dataset.performanceMode;
  });

  it("returns 200ms for enter and 120ms for exit", () => {
    expect(getUiTransitionDuration("enter")).toBe(UI_ENTER_DURATION);
    expect(getUiTransitionDuration("enter")).toBe(200);
    expect(getUiTransitionDuration("exit")).toBe(UI_EXIT_DURATION);
    expect(getUiTransitionDuration("exit")).toBe(120);
  });

  it("still returns the full duration when prefers-reduced-motion is active", () => {
    matchMediaSpy.mockReturnValue({ matches: true });
    expect(getUiTransitionDuration("enter")).toBe(200);
    expect(getUiTransitionDuration("exit")).toBe(120);
  });

  it("returns 0 when performance mode is active (skip-timer signal)", () => {
    document.body.dataset.performanceMode = "true";
    expect(getUiTransitionDuration("enter")).toBe(0);
    expect(getUiTransitionDuration("exit")).toBe(0);
  });
});

describe("getTerminalAnimationDuration", () => {
  it("returns 0 — panel close is instant", () => {
    expect(getTerminalAnimationDuration()).toBe(TERMINAL_ANIMATION_DURATION);
    expect(getTerminalAnimationDuration()).toBe(0);
  });
});

describe("getUiAnimationDuration", () => {
  beforeEach(() => {
    document.body.dataset.performanceMode = "false";
  });

  afterEach(() => {
    delete document.body.dataset.performanceMode;
  });

  it("returns the UI animation token regardless of prefers-reduced-motion", () => {
    expect(getUiAnimationDuration()).toBe(UI_ANIMATION_DURATION);
    expect(getUiAnimationDuration()).toBe(150);
  });

  it("returns 0 when performance mode is active", () => {
    document.body.dataset.performanceMode = "true";
    expect(getUiAnimationDuration()).toBe(0);
  });
});

describe("spring easing constants", () => {
  it("exports valid easing strings", () => {
    expect(UI_ENTER_EASING).toMatch(/^linear\(/);
    expect(UI_EXIT_EASING).toMatch(/^cubic-bezier\(/);
  });

  it("uses asymmetric durations with exit faster than enter", () => {
    expect(UI_EXIT_DURATION).toBeLessThan(UI_ENTER_DURATION);
    expect(UI_EXIT_DURATION / UI_ENTER_DURATION).toBe(0.6);
  });
});

describe("--anti-flicker-delay CSS contract", () => {
  // Read the source CSS once. Asserting authored intent in src/index.css —
  // the build pipeline (Tailwind, autoprefixer) doesn't affect these regexes.
  const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

  it("declares --anti-flicker-delay inside the :root block", () => {
    // Scope matters: a stray declaration in a narrower selector would let
    // var() fall through to its initial value for consumers outside that
    // scope. Anchor the property to the :root block so the test fails if it
    // ever migrates out.
    expect(css).toMatch(/:root\s*\{[^}]*--anti-flicker-delay\s*:\s*\d+ms/);
  });

  it("declares --anti-flicker-delay exactly once", () => {
    // A second declaration in a media query or duplicate :root would let the
    // cascade resolve to a different value while the first-match parity test
    // below still passes — guard against that. The trailing `(?!-)` rules out
    // the sibling `--anti-flicker-delay-palette` token.
    const declarations = css.match(/--anti-flicker-delay(?!-)\s*:/g) ?? [];
    expect(declarations.length).toBe(1);
  });

  it("token value matches UI_DOHERTY_THRESHOLD", () => {
    const match = css.match(/--anti-flicker-delay(?!-)\s*:\s*(\d+)ms/);
    expect(match).not.toBeNull();
    if (!match?.[1]) return;
    const ms = Number.parseInt(match[1], 10);
    expect(ms).toBe(UI_DOHERTY_THRESHOLD);
  });

  it(".animate-pulse-delayed references the token (not a bare literal)", () => {
    expect(css).toMatch(
      /\.animate-pulse-delayed\s*\{[\s\S]*?animation-delay:\s*var\(--anti-flicker-delay\)/
    );
    expect(css).not.toMatch(/\.animate-pulse-delayed\s*\{[\s\S]*?animation-delay:\s*\d+ms/);
  });

  it(".surface-stale transition references the Doherty token (discrete-action gate)", () => {
    expect(css).toMatch(
      /\.surface-stale\s*\{[^}]*?transition:\s*opacity\s+150ms\s+ease-out\s+var\(--anti-flicker-delay\)/
    );
  });
});

describe("--anti-flicker-delay-palette CSS contract", () => {
  // Palette typed-input stale-dim uses a shorter gate than Doherty's 400ms —
  // keystrokes arrive every ~200ms at normal speed, so a 400ms gate would
  // almost never fire before the next keystroke resets it. Industry convention
  // (Algolia, React useDeferredValue) is 200ms. Asserting the split so future
  // changes can't silently recombine the two tokens.
  const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

  it("declares --anti-flicker-delay-palette inside the :root block", () => {
    expect(css).toMatch(/:root\s*\{[^}]*--anti-flicker-delay-palette\s*:\s*\d+ms/);
  });

  it("declares --anti-flicker-delay-palette exactly once", () => {
    const declarations = css.match(/--anti-flicker-delay-palette\s*:/g) ?? [];
    expect(declarations.length).toBe(1);
  });

  it("token value matches UI_PALETTE_STALE_DELAY", () => {
    const match = css.match(/--anti-flicker-delay-palette\s*:\s*(\d+)ms/);
    expect(match).not.toBeNull();
    if (!match?.[1]) return;
    const ms = Number.parseInt(match[1], 10);
    expect(ms).toBe(UI_PALETTE_STALE_DELAY);
  });

  it(".palette-results-stale transition references the palette token (not Doherty)", () => {
    expect(css).toMatch(
      /\.palette-results-stale\s*\{[^}]*?transition:\s*opacity\s+150ms\s+ease-out\s+var\(--anti-flicker-delay-palette\)/
    );
    // Negative assertion: prevent accidental recombination with the Doherty token.
    expect(css).not.toMatch(
      /\.palette-results-stale\s*\{[^}]*?transition:[^}]*var\(--anti-flicker-delay\)(?!-)/
    );
  });

  it("UI_PALETTE_STALE_DELAY is shorter than UI_DOHERTY_THRESHOLD", () => {
    // Encodes the architectural intent: typed-input feedback must fire faster
    // than discrete-action skeletons, or the palette gate stops firing in
    // practice at normal typing speeds.
    expect(UI_PALETTE_STALE_DELAY).toBeLessThan(UI_DOHERTY_THRESHOLD);
  });
});

describe("discrete-feedback easing CSS contract", () => {
  // Discrete, user-triggered feedback animations must use the front-loaded
  // --ease-out-expo token so they snap immediately on trigger. The symmetric
  // Material curve cubic-bezier(0.4, 0, 0.2, 1) reads as sluggish for one-shot
  // feedback — it belongs to ambient loops (terminal-ping wash) and interactive
  // base transitions (--focus-transition-easing), which intentionally retain it.
  // This contract guards against either drifting back onto the symmetric literal.
  const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

  // Each selector's block is extracted individually so the negative assertion
  // can't tunnel across a closing brace into a neighbouring rule that legitimately
  // keeps the symmetric literal (terminal-ping, --focus-transition-easing).
  const discreteFeedbackSelectors = [
    ".animate-badge-bump",
    ".animate-checkbox-check",
    ".animate-action-row-bump",
    ".animate-diagnostics-flash",
    ".animate-upstream-badge-flash",
    ".animate-activity-blip",
    ".animate-trash-pulse",
    ".animate-fleet-bar-refocus-pulse::before",
    ".animate-fleet-bar-commit-flash::before",
    ".fleet-exit-pulse-overlay",
    ".fleet-preview-enter-overlay",
  ];

  const blockRegex = (selector: string): RegExp => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g");
  };

  const extractBlock = (selector: string): string | null =>
    css.match(blockRegex(selector))?.[0].match(/\{([\s\S]*?)\}/)?.[1] ?? null;

  it("anchors the swap to the source-of-truth token value", () => {
    // The swaps only matter if --ease-out-expo still resolves to the
    // front-loaded curve. Link the CSS token to the TS constant so a silent
    // redefinition can't pass the per-selector reference checks below.
    const match = css.match(/--ease-out-expo\s*:\s*([^;]+);/);
    expect(match?.[1]?.trim()).toBe(EASE_OUT_EXPO);
  });

  it.each(discreteFeedbackSelectors)(
    "%s — any duplicate block only disables motion",
    (selector) => {
      // extractBlock reads the first (base) rule. These selectors legitimately
      // recur inside the reduced-motion media query, but only to set
      // `animation: none`. Guard the false-negative the review flagged: a later
      // duplicate that reverted the easing to a real curve would win the cascade
      // while the base-block checks below still passed.
      const bodies = [...css.matchAll(blockRegex(selector))].map((m) => m[1]);
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      bodies.slice(1).forEach((body) => {
        expect(body).toMatch(/animation:\s*none/);
      });
    }
  );

  it.each(discreteFeedbackSelectors)("%s references var(--ease-out-expo)", (selector) => {
    const block = extractBlock(selector);
    expect(block).not.toBeNull();
    // (?<!-) rules out a custom property like `--animation:` shadowing the real one.
    expect(block).toMatch(/(?<!-)animation:[^;]*var\(--ease-out-expo\)/);
  });

  it.each(discreteFeedbackSelectors)(
    "%s does not fall back to the symmetric Material curve (literal, alias, or longhand)",
    (selector) => {
      const block = extractBlock(selector);
      expect(block).not.toBeNull();
      // Ban the raw literal, the --focus-transition-easing alias that resolves
      // to it, and any animation-timing-function longhand that would silently
      // override the shorthand's easing.
      expect(block).not.toMatch(/cubic-bezier\(0\.4,\s*0,\s*0\.2,\s*1\)/);
      expect(block).not.toMatch(/var\(--focus-transition-easing\)/);
      expect(block).not.toMatch(/animation-timing-function\s*:/);
    }
  );
});

describe("panel-motion-tier CSS contract (#10704)", () => {
  // The asymmetric assistant slide uses --duration-120 + --ease-panel-minimize
  // from the @theme block. These cross-check the CSS tokens against the JS
  // constants in animationUtils.ts (two separate sources of truth), so a silent
  // drift in either layer fails here rather than shipping a desynced curve.
  const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

  it("--duration-120 token matches PANEL_MINIMIZE_DURATION", () => {
    const match = css.match(/--duration-120\s*:\s*([^;]+);/);
    expect(match).not.toBeNull();
    expect(match?.[1]?.trim()).toBe(`${PANEL_MINIMIZE_DURATION}ms`);
  });

  it("--ease-panel-minimize token matches PANEL_MINIMIZE_EASING", () => {
    const match = css.match(/--ease-panel-minimize\s*:\s*([^;]+);/);
    expect(match).not.toBeNull();
    expect(match?.[1]?.trim()).toBe(PANEL_MINIMIZE_EASING);
  });

  it("--duration-200 token matches PANEL_RESTORE_DURATION (enter side)", () => {
    const match = css.match(/--duration-200\s*:\s*([^;]+);/);
    expect(match).not.toBeNull();
    expect(match?.[1]?.trim()).toBe(`${PANEL_RESTORE_DURATION}ms`);
  });

  it("--ease-out-expo token matches PANEL_RESTORE_EASING (enter side)", () => {
    const match = css.match(/--ease-out-expo\s*:\s*([^;]+);/);
    expect(match).not.toBeNull();
    expect(match?.[1]?.trim()).toBe(PANEL_RESTORE_EASING);
  });
});

describe("UI_SPIN_CYCLE_MS ↔ Tailwind .animate-spin drift contract", () => {
  // UI_SPIN_CYCLE_MS is the JS backstop that clears a spinning refresh icon when
  // the CSS animation is suppressed (reduced-motion / performance mode) and no
  // `animationiteration` event ever fires. It is only correct while it equals
  // one real rotation of Tailwind's built-in `.animate-spin`. Tailwind owns that
  // duration via `--animate-spin: spin <N>s linear infinite` in its shipped
  // theme.css — a second, independent source of truth. Parse it and fail here if
  // a Tailwind upgrade ever changes the spin duration out from under the
  // constant, rather than shipping a backstop that stops mid-rotation.
  const themeCss = readFileSync(
    resolve(__dirname, "../../../node_modules/tailwindcss/theme.css"),
    "utf8"
  );

  it("Tailwind declares --animate-spin as an infinite linear spin", () => {
    expect(themeCss).toMatch(/--animate-spin\s*:\s*spin\s+[\d.]+s\s+linear\s+infinite/);
  });

  it("UI_SPIN_CYCLE_MS equals Tailwind's spin duration in milliseconds", () => {
    const match = themeCss.match(/--animate-spin\s*:\s*spin\s+([\d.]+)s\b/);
    expect(match).not.toBeNull();
    if (!match?.[1]) return;
    const tailwindMs = Math.round(Number.parseFloat(match[1]) * 1000);
    expect(UI_SPIN_CYCLE_MS).toBe(tailwindMs);
  });
});

describe(".animate-spin suppression CSS contract (SpinningIcon backstop premise)", () => {
  // SpinningIcon's JS backstop timer exists ONLY because reduced-motion and
  // performance mode set `animation: none` on the spinning icon, so no
  // `animationiteration` event ever fires to stop it at a rotation boundary.
  // Guard that premise — if either rule stopped suppressing the animation, the
  // backstop would be arming for a case that no longer needs it (harmless), but
  // if BOTH the event and the suppression drifted, a real user could be stranded
  // mid-spin. These assertions fail loudly if the suppression is removed.
  const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

  it("reduced-motion neutralizes .animate-spin", () => {
    expect(css).toMatch(/\.animate-spin\b[\s\S]{0,800}animation:\s*none/);
  });

  it("performance mode disables animation globally with !important", () => {
    expect(css).toMatch(
      /body\[data-performance-mode="true"\] \*[\s\S]*?animation:\s*none\s*!important/
    );
  });
});
