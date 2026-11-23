// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDeadlineClock, useDecisionsClock } from "../useDecisionsClock";

const MINUTE = 60_000;
const START = Date.parse("2026-11-20T14:00:00.000Z");

let wake: (() => void) | null = null;
const offWake = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  wake = null;
  offWake.mockClear();
  Reflect.set(window, "electron", {
    systemSleep: {
      onWake: (listener: () => void) => {
        wake = listener;
        return offWake;
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "electron");
});

const readings: number[] = [];

function Clock({
  deadlines,
  active = true,
  detailed,
}: {
  deadlines: (string | null)[];
  active?: boolean;
  detailed?: boolean;
}) {
  readings.push(useDecisionsClock(deadlines, active, detailed));
  return null;
}

function Deadline({ expiresAt }: { expiresAt: string | null }) {
  readings.push(useDeadlineClock(expiresAt));
  return null;
}

describe("useDecisionsClock (#17943)", () => {
  it("moves only when a deadline would read differently, never every second", () => {
    readings.length = 0;
    const deadline = new Date(START + 2 * MINUTE + 30_000).toISOString();
    render(<Clock deadlines={[deadline]} />);
    const first = readings.length;

    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(readings.length).toBe(first);
    // Just past 30 s, "2 minutes left" becomes "1 minute left".
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(readings.length).toBe(first + 1);
    expect(readings.at(-1)).toBe(START + 30_001);
  });

  it("catches up when the machine wakes, though no timer fired while it slept", () => {
    readings.length = 0;
    const deadline = new Date(START + 10 * MINUTE).toISOString();
    render(<Clock deadlines={[deadline]} />);
    // A sleep: the wall clock jumps an hour while no timer ran.
    vi.setSystemTime(START + 60 * MINUTE);
    act(() => {
      wake?.();
    });
    expect(readings.at(-1)).toBe(START + 60 * MINUTE);
  });

  it("schedules nothing while inactive, and lets go of the wake listener on unmount", () => {
    readings.length = 0;
    const deadline = new Date(START + MINUTE / 2).toISOString();
    const { rerender, unmount } = render(<Clock deadlines={[deadline]} active={false} />);
    expect(wake).toBeNull();
    act(() => {
      vi.advanceTimersByTime(MINUTE);
    });
    expect(readings.length).toBe(1);

    rerender(<Clock deadlines={[deadline]} active />);
    expect(wake).not.toBeNull();
    unmount();
    expect(offWake).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useDecisionsClock coming back into use (#17943)", () => {
  it("reads the clock afresh as it becomes active, so a deadline passed while idle shows passed", () => {
    readings.length = 0;
    const deadline = new Date(START + MINUTE).toISOString();
    const { rerender } = render(<Clock deadlines={[deadline]} active={false} />);
    vi.setSystemTime(START + 2 * MINUTE);
    rerender(<Clock deadlines={[deadline]} active />);
    expect(readings.at(-1)).toBe(START + 2 * MINUTE);
  });
});

describe("useDecisionsClock waiting only for deadlines (#18053)", () => {
  it("moves only as each deadline passes, at the deadline itself, and never for the minutes ticking down", () => {
    readings.length = 0;
    const first = new Date(START + 2 * MINUTE + 30_000).toISOString();
    const second = new Date(START + 3 * 24 * 60 * MINUTE).toISOString();
    render(<Clock deadlines={[second, first, null]} detailed={false} />);
    expect(readings).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(2 * MINUTE + 29_999);
    });
    expect(readings).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(readings.at(-1)).toBe(START + 2 * MINUTE + 30_000);

    const renders = readings.length;
    // Neither the day boundary nor an hour turning moves it before the second deadline.
    act(() => {
      vi.advanceTimersByTime(2 * 24 * 60 * MINUTE);
    });
    expect(readings.length).toBe(renders);
    act(() => {
      vi.advanceTimersByTime(24 * 60 * MINUTE);
    });
    expect(readings.at(-1)).toBe(Date.parse(second));
    // Every deadline has passed: nothing is waited for.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("takes a fresh reading as it turns detailed, and lets go of its timer and listener on unmount", () => {
    readings.length = 0;
    const deadline = new Date(START + 10 * MINUTE).toISOString();
    const { rerender, unmount } = render(<Clock deadlines={[deadline]} detailed={false} />);
    expect(vi.getTimerCount()).toBe(1);
    vi.setSystemTime(START + MINUTE);
    rerender(<Clock deadlines={[deadline]} />);
    expect(readings.at(-1)).toBe(START + MINUTE);
    expect(offWake).toHaveBeenCalledTimes(1);
    unmount();
    expect(offWake).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useDeadlineClock (#17943)", () => {
  it("moves once as the deadline passes, and once on a wake before it, then never again", () => {
    readings.length = 0;
    const deadline = new Date(START + 5 * MINUTE).toISOString();
    render(<Deadline expiresAt={deadline} />);
    act(() => {
      vi.advanceTimersByTime(4 * MINUTE);
    });
    expect(readings.length).toBe(1);

    vi.setSystemTime(START + 6 * MINUTE);
    act(() => {
      wake?.();
    });
    expect(readings.at(-1)).toBe(START + 6 * MINUTE);
    // Passed: nothing is waited for any more.
    expect(vi.getTimerCount()).toBe(0);
  });
});
