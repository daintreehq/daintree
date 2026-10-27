// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { polishingShareAt, VoiceSubmitProgress } from "../VoiceSubmitProgress";
import type { VoiceSubmitWait } from "../hooks/useVoiceWaitSubmit";

const polishing = (
  beganAt: number | null,
  expectedAt: number | null,
  startedAt = 5_000
): VoiceSubmitWait => ({
  attempt: 1,
  phase: "polishing",
  startedAt,
  beganAt,
  expectedAt,
  sessions: new Set(["s1"]),
});

/** Share of the shell a keyframe's transform covers. */
const shareOf = (keyframe: Keyframe) =>
  1 + Number(/translateX\((-?[\d.e-]+)%\)/.exec(String(keyframe.transform))![1]) / 100;

describe("polishingShareAt", () => {
  const wait = polishing(1_000, 3_000);

  it("opens near empty when Enter comes just after the request went out", () => {
    expect(polishingShareAt(wait, 1_200)).toBeCloseTo(0.09);
  });

  it("opens at the elapsed share when Enter comes halfway", () => {
    expect(polishingShareAt(wait, 2_000)).toBeCloseTo(0.45);
  });

  it("stops at the landing's share once the estimate has passed", () => {
    expect(polishingShareAt(wait, 3_000)).toBeCloseTo(0.9);
    expect(polishingShareAt(wait, 9_000)).toBeCloseTo(0.9);
  });

  it("is empty without an estimate, and never before the request", () => {
    expect(polishingShareAt(polishing(null, null), 2_000)).toBe(0);
    expect(polishingShareAt(wait, 500)).toBe(0);
    expect(polishingShareAt({ attempt: 1, phase: "finishing", startedAt: 0 }, 2_000)).toBe(0);
  });

  it("counts a request that went out at time zero, and a window with no length", () => {
    expect(polishingShareAt(polishing(0, 2_000), 1_000)).toBeCloseTo(0.45);
    expect(polishingShareAt(polishing(2_000, 2_000), 2_000)).toBeCloseTo(0.9);
  });
});

describe("VoiceSubmitProgress", () => {
  let clock = 0;
  let animate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    );
    animate = vi.fn(() => ({ cancel() {}, pause() {}, onfinish: null }));
    Object.assign(HTMLElement.prototype, { animate, getAnimations: () => [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Renders the wait as Enter lands at `enterAt`, and opens the gate. */
  const open = (wait: VoiceSubmitWait, enterAt: number, streamed: number | null = null) => {
    clock = enterAt;
    render(
      <VoiceSubmitProgress wait={wait} outcome={null} streamed={streamed} onPresentChange={vi.fn()} />
    );
    clock = enterAt + UI_INLINE_LOADING_GATE_MS;
    act(() => {
      vi.advanceTimersByTime(UI_INLINE_LOADING_GATE_MS);
    });
    const [keyframes, options] = animate.mock.lastCall as [Keyframe[], KeyframeAnimationOptions];
    return { keyframes, options };
  };

  it("opens a bar shown halfway through the cleanup at its elapsed share, landing on time", () => {
    const { keyframes, options } = open(polishing(1_000, 3_000), 1_800);
    // The gate opens 200ms later, at 2s: half the window gone.
    expect(shareOf(keyframes[0]!)).toBeCloseTo(0.45);
    expect(shareOf(keyframes[1]!)).toBeCloseTo(0.9);
    const duration = options.duration as number;
    expect((keyframes[1]!.offset as number) * duration).toBeCloseTo(1_000);
  });

  it("opens a bar shown early near empty", () => {
    const { keyframes } = open(polishing(1_000, 3_000), 1_000);
    expect(shareOf(keyframes[0]!)).toBeCloseTo(0.09);
  });

  it("opens a bar shown past the estimate at the landing's share, creeping on", () => {
    const { keyframes } = open(polishing(1_000, 3_000), 4_000);
    expect(shareOf(keyframes[0]!)).toBeCloseTo(0.9);
    expect(shareOf(keyframes[keyframes.length - 1]!)).toBeGreaterThan(0.9);
  });

  it("opens an unestimated wait from empty, as before", () => {
    const { keyframes } = open(polishing(null, null, 1_000), 1_000);
    expect(shareOf(keyframes[0]!)).toBe(0);
  });

  it("opens a bar on a cleanup already writing where the words are", () => {
    const { keyframes } = open(polishing(1_000, 3_000), 1_800, 0.5);
    expect(shareOf(keyframes[0]!)).toBeCloseTo(shareOf(keyframes[1]!));
    expect(shareOf(keyframes[0]!)).toBeCloseTo(0.49);
  });
});
