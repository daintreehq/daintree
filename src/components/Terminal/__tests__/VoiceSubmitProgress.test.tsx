// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { describeChord, formatChordText } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";
import {
  polishingShareAt,
  VoiceSubmitProgress,
  voiceSubmitWaitCaption,
  voiceSubmitWaitStatus,
  type VoiceSubmitWaitKeys,
} from "../VoiceSubmitProgress";
import type { VoiceSubmitOutcome, VoiceSubmitWait } from "../hooks/useVoiceWaitSubmit";

const polishing = (
  beganAt: number | null,
  expectedAt: number | null,
  startedAt = 5_000,
  byStopAndSend = false
): VoiceSubmitWait => ({
  attempt: 1,
  phase: "polishing",
  startedAt,
  byStopAndSend,
  beganAt,
  expectedAt,
  sessions: new Set(["s1"]),
});
const finishing: VoiceSubmitWait = {
  attempt: 1,
  phase: "finishing",
  startedAt: 0,
  byStopAndSend: false,
};

// The keyboard in the composer, or nowhere with this the one wait.
const IN_REACH: VoiceSubmitWaitKeys = { enter: true, escape: true, skip: null };
// The keyboard in another pane, where Enter and Escape are that pane's.
const ELSEWHERE: VoiceSubmitWaitKeys = { enter: false, escape: false, skip: null };
const SKIP_COMBO = "Cmd+Alt+D";

/** Share of the shell a keyframe's transform covers. */
const shareOf = (keyframe: Keyframe | undefined) =>
  1 + Number(/translateX\((-?[\d.e-]+)%\)/.exec(String(keyframe?.transform))?.[1]) / 100;

describe("polishingShareAt", () => {
  const wait = polishing(1_000, 3_000);
  const landing = polishingShareAt(wait, 3_000);

  it("keeps the landing's share short of full, for the overrun to creep into", () => {
    expect(landing).toBeGreaterThan(0);
    expect(landing).toBeLessThan(1);
  });

  it("opens near empty when Enter comes just after the request went out", () => {
    expect(polishingShareAt(wait, 1_200)).toBeCloseTo(landing * 0.1);
  });

  it("opens at the elapsed share when Enter comes halfway", () => {
    expect(polishingShareAt(wait, 2_000)).toBeCloseTo(landing / 2);
  });

  it("stops at the landing's share once the estimate has passed", () => {
    expect(polishingShareAt(wait, 9_000)).toBe(landing);
  });

  it("is empty without an estimate, and never before the request", () => {
    expect(polishingShareAt(polishing(null, null), 2_000)).toBe(0);
    expect(polishingShareAt(wait, 500)).toBe(0);
    expect(polishingShareAt(finishing, 2_000)).toBe(0);
  });

  it("counts a request that went out at time zero, and a window with no length", () => {
    expect(polishingShareAt(polishing(0, 2_000), 1_000)).toBeCloseTo(landing / 2);
    expect(polishingShareAt(polishing(2_000, 2_000), 2_000)).toBe(landing);
  });
});

describe("voiceSubmitWaitCaption", () => {
  const skipText = formatChordText(SKIP_COMBO, isMac());

  it("offers Enter as the way to send as dictated only while the cleanup is awaited", () => {
    expect(voiceSubmitWaitCaption(polishing(1_000, 3_000), IN_REACH)).toMatch(/Enter.*as dictated/);
    expect(voiceSubmitWaitCaption(finishing, IN_REACH)).not.toMatch(/Enter/);
    for (const wait of [polishing(null, null), finishing]) {
      expect(voiceSubmitWaitCaption(wait, IN_REACH)).toMatch(/Esc/);
    }
  });

  // #15705: Enter and Escape typed in another pane are that pane's.
  it("names neither Enter nor Escape when they don't reach the wait", () => {
    for (const wait of [polishing(1_000, 3_000), finishing]) {
      const caption = voiceSubmitWaitCaption(wait, ELSEWHERE);
      expect(caption).not.toMatch(/Enter|Esc/);
      expect(caption).toMatch(/…$/);
    }
  });

  it("doesn't offer Enter to send from Cancel send, where Enter cancels", () => {
    const caption = voiceSubmitWaitCaption(polishing(1_000, 3_000), {
      enter: false,
      escape: true,
      skip: null,
    });
    expect(caption).not.toMatch(/Enter/);
    expect(caption).toMatch(/Esc to cancel/);
  });

  it("names the stop-and-send key for a send it started, from wherever the keyboard is", () => {
    const wait = polishing(1_000, 3_000, 5_000, true);
    const elsewhere = voiceSubmitWaitCaption(wait, { ...ELSEWHERE, skip: SKIP_COMBO });
    expect(elsewhere).toContain(`${skipText} to send as dictated`);
    expect(elsewhere).not.toMatch(/Esc/);

    const inReach = voiceSubmitWaitCaption(wait, { ...IN_REACH, skip: SKIP_COMBO });
    expect(inReach).toContain(`${skipText} to send as dictated`);
    expect(inReach).not.toMatch(/Enter to send/);
    expect(inReach).toMatch(/Esc to cancel/);
  });

  it("names no key to send a stop-and-send wait that only the transcript holds, or one with the key unbound", () => {
    const finishingSend: VoiceSubmitWait = { ...finishing, byStopAndSend: true };
    expect(voiceSubmitWaitCaption(finishingSend, { ...ELSEWHERE, skip: SKIP_COMBO })).not.toContain(
      skipText
    );
    expect(voiceSubmitWaitCaption(polishing(1_000, 3_000, 5_000, true), ELSEWHERE)).not.toMatch(
      /as dictated/
    );
  });
});

describe("voiceSubmitWaitStatus", () => {
  it("says the ways out the caption names, in words", () => {
    expect(voiceSubmitWaitStatus(polishing(1_000, 3_000), IN_REACH)).toBe(
      "Polishing dictation. Press Enter to send it as dictated, or Escape to cancel the send."
    );
    expect(voiceSubmitWaitStatus(finishing, IN_REACH)).toBe(
      "Finishing dictation. Press Escape to cancel the send."
    );
    expect(voiceSubmitWaitStatus(polishing(1_000, 3_000), ELSEWHERE)).toBe("Polishing dictation.");
  });

  it("reads the stop-and-send key aloud for a send it started", () => {
    const status = voiceSubmitWaitStatus(polishing(1_000, 3_000, 5_000, true), {
      ...ELSEWHERE,
      skip: SKIP_COMBO,
    });
    expect(status).toBe(
      `Polishing dictation. Press ${describeChord(SKIP_COMBO, isMac())} to send it as dictated.`
    );
  });
});

describe("VoiceSubmitProgress", () => {
  let clock = 0;
  /** How much of the shell the fill covers, as the browser would report it. */
  let drawn = 0;
  const animate =
    vi.fn<(keyframes: Keyframe[], options: KeyframeAnimationOptions) => Partial<Animation>>();

  beforeEach(() => {
    clock = 0;
    drawn = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    );
    vi.stubGlobal(
      "DOMMatrixReadOnly",
      class {
        m41 = (drawn - 1) * 100;
      }
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
    animate.mockReset().mockReturnValue({ cancel() {}, pause() {}, onfinish: null });
    Object.assign(HTMLElement.prototype, { animate, getAnimations: () => [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const lastAnimation = () => {
    const [keyframes, options] = animate.mock.lastCall!;
    return {
      keyframes,
      from: shareOf(keyframes[0]),
      to: shareOf(keyframes[keyframes.length - 1]),
      /** How long the fill takes to reach its second keyframe. */
      firstMs: Number(keyframes[1]?.offset ?? 1) * Number(options.duration),
    };
  };

  /** Renders the wait as Enter lands at `enterAt`, and opens the gate. */
  const open = (wait: VoiceSubmitWait, enterAt: number, streamed: number | null = null) => {
    clock = enterAt;
    const view = render(
      <VoiceSubmitProgress
        keys={IN_REACH}
        wait={wait}
        outcome={null}
        streamed={streamed}
        onPresentChange={vi.fn()}
      />
    );
    clock = enterAt + UI_INLINE_LOADING_GATE_MS;
    act(() => {
      vi.advanceTimersByTime(UI_INLINE_LOADING_GATE_MS);
    });
    const rerender = (next: VoiceSubmitWait, nextStreamed: number | null = null) => {
      view.rerender(
        <VoiceSubmitProgress
          keys={IN_REACH}
          wait={next}
          outcome={null}
          streamed={nextStreamed}
          onPresentChange={vi.fn()}
        />
      );
      return lastAnimation();
    };
    return { ...lastAnimation(), rerender, unmount: view.unmount };
  };

  const landing = polishingShareAt(polishing(1_000, 3_000), 3_000);

  it("opens a bar shown halfway through the cleanup at its elapsed share, landing on time", () => {
    const { from, keyframes, firstMs } = open(polishing(1_000, 3_000), 1_800);
    // The gate opens 200ms later, at 2s: half the window gone.
    expect(from).toBeCloseTo(landing / 2);
    expect(shareOf(keyframes[1])).toBeCloseTo(landing);
    expect(firstMs).toBeCloseTo(1_000);
  });

  it("opens a bar shown early near empty", () => {
    expect(open(polishing(1_000, 3_000), 1_000).from).toBeCloseTo(landing * 0.1);
  });

  it("lands on time even when the landing is moments away", () => {
    const { from, firstMs } = open(polishing(1_000, 3_000), 2_700);
    expect(from).toBeCloseTo(landing * 0.95);
    expect(firstMs).toBeCloseTo(100);
  });

  it("opens a bar shown past the estimate at the landing's share, creeping on", () => {
    const { from, to } = open(polishing(1_000, 3_000), 4_000);
    expect(from).toBeCloseTo(landing);
    expect(to).toBeGreaterThan(landing);
  });

  it("opens an unestimated wait from empty, as before", () => {
    const { from, firstMs } = open(polishing(null, null, 1_000), 1_000);
    expect(from).toBe(0);
    expect(firstMs).toBeGreaterThan(0);
  });

  it("opens a bar on a cleanup already writing where the words are", () => {
    const half = open(polishing(1_000, 3_000), 1_800, 0.5);
    half.unmount();
    const whole = open(polishing(1_000, 3_000), 1_800, 1);
    expect(half.from).toBeCloseTo(half.to);
    expect(whole.from).toBeCloseTo(whole.to);
    expect(half.from).toBeCloseTo(whole.from / 2);
  });

  describe("receipt", () => {
    const sent = (cleanup?: VoiceSubmitOutcome["cleanup"]): VoiceSubmitOutcome =>
      cleanup ? { kind: "sent", attempt: 1, cleanup } : { kind: "sent", attempt: 1 };
    const captionOf = (container: HTMLElement) =>
      container.querySelector("[data-voice-submit-caption]")?.textContent ?? null;
    const reachesFull = () =>
      animate.mock.calls.some(([keyframes]) =>
        keyframes.some((frame) => frame.transform !== undefined && shareOf(frame) === 1)
      );

    function settle(outcome: VoiceSubmitOutcome, options: { gateOpened: boolean }) {
      const onPresentChange = vi.fn();
      const wait = polishing(1_000, 3_000);
      const view = render(
        <VoiceSubmitProgress
          keys={IN_REACH}
          wait={wait}
          outcome={null}
          onPresentChange={onPresentChange}
        />
      );
      if (options.gateOpened) {
        act(() => {
          vi.advanceTimersByTime(UI_INLINE_LOADING_GATE_MS);
        });
      }
      view.rerender(
        <VoiceSubmitProgress
          keys={IN_REACH}
          wait={null}
          outcome={outcome}
          onPresentChange={onPresentChange}
        />
      );
      return { caption: captionOf(view.container), onPresentChange, unmount: view.unmount };
    }

    it("ends a send whose cleanup landed on Sent, and one without it on a receipt saying which", () => {
      const captions = (["landed", "skipped", "failed"] as const).map((how) => {
        const settled = settle(sent(how === "landed" ? undefined : how), { gateOpened: true });
        settled.unmount();
        return settled.caption;
      });

      expect(captions[0]).toBe("Sent");
      expect(captions[1]).toMatch(/^Sent.*skipped/);
      expect(captions[2]).toMatch(/^Sent.*failed/);
    });

    it("fills the bar for a send that went without its cleanup, as for any that went", () => {
      settle(sent("skipped"), { gateOpened: true });
      expect(reachesFull()).toBe(true);
    });

    it("tells a send that went without its cleanup even when its wait ended inside the gate", () => {
      const { caption, onPresentChange } = settle(sent("failed"), { gateOpened: false });
      expect(caption).toMatch(/failed/);
      expect(onPresentChange).toHaveBeenLastCalledWith(true);
    });

    it("tells it once: a receipt that has faded stays gone", () => {
      // Every animation hands back this one, so it holds the caption's fade last.
      const fade = { cancel() {}, pause() {}, onfinish: null as (() => void) | null };
      animate.mockReturnValue(fade);
      const onPresentChange = vi.fn();
      const view = render(
        <VoiceSubmitProgress
          keys={IN_REACH}
          wait={polishing(1_000, 3_000)}
          outcome={null}
          onPresentChange={onPresentChange}
        />
      );
      view.rerender(
        <VoiceSubmitProgress
          keys={IN_REACH}
          wait={null}
          outcome={sent("failed")}
          onPresentChange={onPresentChange}
        />
      );
      expect(captionOf(view.container)).toMatch(/failed/);

      act(() => {
        fade.onfinish?.();
      });
      expect(captionOf(view.container)).toBeNull();
      expect(onPresentChange).toHaveBeenLastCalledWith(false);

      view.rerender(
        <VoiceSubmitProgress
          keys={IN_REACH}
          wait={null}
          outcome={sent("failed")}
          onPresentChange={onPresentChange}
        />
      );
      expect(captionOf(view.container)).toBeNull();
    });

    it("fades a send a new dictation reopened saying so, and one called off on its wait", () => {
      const reopened = settle({ kind: "reopened", attempt: 1 }, { gateOpened: true });
      reopened.unmount();
      const cancelled = settle({ kind: "cancelled", attempt: 1 }, { gateOpened: true });

      expect(reopened.caption).toMatch(/^Send reopened/);
      expect(cancelled.caption).toMatch(/^Polishing/);
      expect(reachesFull()).toBe(false);
    });

    it("leaves a clean send whose wait ended inside the gate unsaid", () => {
      const { caption, onPresentChange } = settle(sent(), { gateOpened: false });
      expect(caption).toBeNull();
      expect(onPresentChange).not.toHaveBeenCalledWith(true);
    });
  });

  it("never moves back as the wait goes from finishing to polishing to writing", () => {
    const { rerender } = open(finishing, 1_000);

    // Polishing begins with the drain's creep ahead of the cleanup's timeline.
    drawn = 0.3;
    const polished = rerender(polishing(1_000, 3_000));
    expect(polished.from).toBeCloseTo(0.3);
    expect(polished.to).toBeGreaterThan(0.3);

    // Writing starts where the fill stands, not where a fresh bar would open.
    drawn = 0.5;
    const writing = rerender(polishing(1_000, 3_000), 0.2);
    expect(writing.from).toBeCloseTo(0.5);
    expect(writing.to).toBeGreaterThan(0.5);

    // A streamed share that falls back holds the fill where it stands.
    drawn = writing.to;
    const fallen = rerender(polishing(1_000, 3_000), 0.1);
    expect(fallen.from).toBeCloseTo(writing.to);
    expect(fallen.to).toBeCloseTo(writing.to);
  });
});
