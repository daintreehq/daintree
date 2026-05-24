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
  EASE_OUT_EXPO,
  EASE_SNAPPY,
  EASE_SPRING_CRITICAL,
  getPanelTransitionDuration,
  getTerminalAnimationDuration,
  getUiAnimationDuration,
  getUiTransitionDuration,
  PANEL_MINIMIZE_DURATION,
  PANEL_RESTORE_DURATION,
  TERMINAL_ANIMATION_DURATION,
  UI_ANIMATION_DURATION,
  UI_DOHERTY_THRESHOLD,
  UI_PALETTE_STALE_DELAY,
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
    // below still passes — guard against that.
    const declarations = css.match(/--anti-flicker-delay\s*:/g) ?? [];
    expect(declarations.length).toBe(1);
  });

  it("token value matches UI_DOHERTY_THRESHOLD", () => {
    const match = css.match(/--anti-flicker-delay\s*:\s*(\d+)ms/);
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

  it(".surface-stale transition references the Doherty token", () => {
    // Background-refresh surfaces stay on the 400ms discrete-action gate.
    // `[^}]*` keeps the match inside the rule so it can't bleed into the
    // sibling `.palette-results-stale` block (which uses a different token).
    expect(css).toMatch(
      /\.surface-stale\s*\{[^}]*?transition:\s*opacity\s+150ms\s+ease-out\s+var\(--anti-flicker-delay\)/
    );
    expect(css).toMatch(/\.surface-stale\s*\{[^}]*?opacity:\s*0\.5/);
  });
});

describe("--palette-stale-delay CSS contract", () => {
  const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

  it("declares --palette-stale-delay inside the :root block", () => {
    expect(css).toMatch(/:root\s*\{[^}]*--palette-stale-delay\s*:\s*\d+ms/);
  });

  it("declares --palette-stale-delay exactly once", () => {
    const declarations = css.match(/--palette-stale-delay\s*:/g) ?? [];
    expect(declarations.length).toBe(1);
  });

  it("token value matches UI_PALETTE_STALE_DELAY", () => {
    const match = css.match(/--palette-stale-delay\s*:\s*(\d+)ms/);
    expect(match).not.toBeNull();
    if (!match?.[1]) return;
    const ms = Number.parseInt(match[1], 10);
    expect(ms).toBe(UI_PALETTE_STALE_DELAY);
  });

  it(".palette-results-stale transition references the palette token", () => {
    // `[^}]*` keeps the match inside the rule so it can't bleed into the
    // sibling `.surface-stale` block (which uses the Doherty token).
    expect(css).toMatch(
      /\.palette-results-stale\s*\{[^}]*?transition:\s*opacity\s+150ms\s+ease-out\s+var\(--palette-stale-delay\)/
    );
  });

  it(".palette-results-stale dims to 0.85 (WCAG-safe on keyboard-navigable rows)", () => {
    expect(css).toMatch(/\.palette-results-stale\s*\{[^}]*?opacity:\s*0\.85/);
  });
});
