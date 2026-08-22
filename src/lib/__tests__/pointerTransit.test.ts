import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createSampler,
  createHoverSettle,
  type HoverSettleController,
  type HoverSuppressionSource,
} from "../pointerTransit";

const MOUSE = { pointerType: "mouse" } as const;

function move(controller: HoverSettleController, x: number, y: number, t: number): void {
  controller.pointerMove({ ...MOUSE, clientX: x, clientY: y, timeStamp: t });
}

/** Feeds samples `stepPx` apart every `stepMs`, i.e. a steady stepPx/stepMs. */
function sweep(
  controller: HoverSettleController,
  { from, stepPx, stepMs, count }: { from: number; stepPx: number; stepMs: number; count: number }
): number {
  let t = from;
  let y = 0;
  for (let i = 0; i < count; i += 1) {
    t += stepMs;
    y += stepPx;
    move(controller, 0, y, t);
  }
  return t;
}

function harness(options?: Parameters<typeof createHoverSettle>[1]) {
  const settled: HoverSuppressionSource[] = [];
  const controller = createHoverSettle({ onSettle: (source) => settled.push(source) }, options);
  return { controller, settled };
}

/** Arms `inside` and gets a suppressed pointer episode running. */
function engagePointer(controller: HoverSettleController): number {
  controller.pointerEnter({ ...MOUSE, clientX: 0, clientY: 0, timeStamp: 0 });
  return sweep(controller, { from: 0, stepPx: 8, stepMs: 8, count: 4 });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSampler", () => {
  it("reports no reading until it has two samples", () => {
    const sampler = createSampler(50);
    sampler.push(0, 0, 0);
    expect(sampler.speed()).toBeNull();
    expect(sampler.recentSpeed()).toBeNull();
  });

  it("reads tremor around a point as still, while a flick still registers instantly", () => {
    const sampler = createSampler(50);
    // Oscillation: far apart consecutively, no net displacement across the window.
    sampler.push(0, 0, 0);
    sampler.push(6, 0, 8);
    sampler.push(0, 0, 16);
    const settledSpeed = sampler.speed();
    expect(settledSpeed).not.toBeNull();
    expect(settledSpeed!).toBeLessThan(sampler.recentSpeed()!);

    // One genuinely fast frame reads fast even though the window is still cold.
    sampler.push(30, 0, 24);
    expect(sampler.recentSpeed()!).toBeGreaterThan(sampler.speed()!);
  });

  it("stays finite when two samples share a timestamp", () => {
    const sampler = createSampler(50);
    sampler.push(0, 0, 100);
    sampler.push(40, 0, 100);
    expect(Number.isFinite(sampler.speed()!)).toBe(true);
    expect(Number.isFinite(sampler.recentSpeed()!)).toBe(true);
  });

  it("keeps the two most recent samples even when both are older than the window", () => {
    const sampler = createSampler(50);
    sampler.push(0, 0, 0);
    sampler.push(10, 0, 10);
    // A long pause: everything predates the cutoff, but a reading must survive.
    sampler.push(10, 0, 5000);
    expect(sampler.speed()).not.toBeNull();
  });

  it("drops samples that fall out of the window", () => {
    const sampler = createSampler(50);
    sampler.push(0, 0, 0);
    sampler.push(100, 0, 10);
    sampler.push(110, 0, 20);
    const withStale = sampler.speed()!;
    // Same trailing motion, but far enough on that the 100px jump ages out.
    sampler.push(120, 0, 80);
    expect(sampler.speed()!).toBeLessThan(withStale);
  });
});

describe("createHoverSettle — pointer authority", () => {
  it("treats an isolated move as intent rather than transit", () => {
    const { controller } = harness();
    controller.pointerEnter({ ...MOUSE, clientX: 0, clientY: 0, timeStamp: 0 });
    move(controller, 0, 0, 0);
    expect(controller.suppressionSource()).toBeNull();
  });

  it("engages on a sustained sweep", () => {
    const { controller } = harness();
    engagePointer(controller);
    expect(controller.suppressionSource()).toBe("pointer");
  });

  it("engages on a flick the windowed reading alone would have missed", () => {
    const { controller } = harness();
    controller.pointerEnter({ ...MOUSE, clientX: 0, clientY: 0, timeStamp: 0 });
    move(controller, 0, 0, 0);
    move(controller, 0, -4, 10);
    expect(controller.suppressionSource()).toBeNull();
    // Back across the start and away: net displacement over the window is 2.5px
    // in 14ms, far too slow to engage, while that last frame alone is 6.5px in
    // 4ms. Waiting for the window to agree is a window's worth of rows flashing.
    move(controller, 0, 2.5, 14);
    expect(controller.suppressionSource()).toBe("pointer");
  });

  it("holds a flick through its cold window, then settles once the floor elapses", () => {
    const { controller, settled } = harness();
    controller.pointerEnter({ ...MOUSE, clientX: 0, clientY: 0, timeStamp: 0 });
    move(controller, 0, 0, 0);
    move(controller, 0, -4, 10);
    move(controller, 0, 2.5, 14);

    // Dead still from here. The windowed reading collapses immediately — which
    // is exactly the cold-window problem the floor exists for — so without it
    // the very next sample would release the flick it just engaged.
    move(controller, 0, 2.5, 24);
    move(controller, 0, 2.5, 54);
    expect(controller.suppressionSource()).toBe("pointer");
    expect(settled).toEqual([]);

    move(controller, 0, 2.5, 64);
    expect(settled).toEqual(["pointer"]);
  });

  it("settles once the pointer homes in after the floor has elapsed", () => {
    const { controller, settled } = harness();
    const t = engagePointer(controller);
    // Far enough past the floor that homing is allowed, and barely moving.
    move(controller, 0, 33, t + 60);
    move(controller, 0, 33, t + 70);
    expect(controller.suppressionSource()).toBeNull();
    expect(settled).toEqual(["pointer"]);
  });

  it("settles on braking, before the pointer has stopped", () => {
    const { controller, settled } = harness();
    controller.pointerEnter({ ...MOUSE, clientX: 0, clientY: 0, timeStamp: 0 });
    // A ballistic peak of 3px/ms, then a decelerating tail.
    move(controller, 0, 0, 0);
    move(controller, 0, 30, 10);
    expect(controller.suppressionSource()).toBe("pointer");
    for (let t = 20, y = 34; t <= 60; t += 10, y += 4) move(controller, 0, y, t);

    // The tail is still covering 4px every 10ms when this fires — a stillness
    // test would still be waiting, which is the dwell timer this replaces.
    expect(settled).toEqual(["pointer"]);
    expect(controller.suppressionSource()).toBeNull();
  });

  it("does not brake out of a gesture whose peak was never ballistic", () => {
    // A slow-but-sweeping gesture halving its speed is the adaptive band
    // wobbling, not a decision — releasing here flashes rows mid-sweep.
    const { controller, settled } = harness();
    controller.pointerEnter({ ...MOUSE, clientX: 0, clientY: 0, timeStamp: 0 });
    move(controller, 0, 0, 0);
    move(controller, 0, 8, 10);
    expect(controller.suppressionSource()).toBe("pointer");
    // Decays to 0.35px/ms — the same braked band that settles the case above,
    // reached from a peak too low for halving to mean anything.
    for (let t = 20, y = 11.5; t <= 70; t += 10, y += 3.5) move(controller, 0, y, t);

    expect(controller.suppressionSource()).toBe("pointer");
    expect(settled).toEqual([]);
  });

  it("settles a stalled gesture on the backstop", async () => {
    vi.useFakeTimers();
    const { controller, settled } = harness();
    engagePointer(controller);
    expect(settled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toEqual(["pointer"]);
    expect(controller.suppressionSource()).toBeNull();
  });

  it("cancels silently when the pointer leaves", async () => {
    vi.useFakeTimers();
    const { controller, settled } = harness();
    engagePointer(controller);
    controller.pointerLeave({ ...MOUSE, clientX: 0, clientY: 0, timeStamp: 0 });
    expect(controller.suppressionSource()).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toEqual([]);
  });

  it("cancels silently on destroy, leaving no backstop behind", async () => {
    vi.useFakeTimers();
    const { controller, settled } = harness();
    engagePointer(controller);
    controller.destroy();
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toEqual([]);
  });

  it("ignores touch and pen entirely", () => {
    const { controller } = harness();
    controller.pointerEnter({ pointerType: "touch", clientX: 0, clientY: 0, timeStamp: 0 });
    for (let i = 0; i < 5; i += 1) {
      controller.pointerMove({
        pointerType: "touch",
        clientX: 0,
        clientY: i * 20,
        timeStamp: i * 8,
      });
    }
    expect(controller.suppressionSource()).toBeNull();
  });
});

describe("createHoverSettle — scroll authority", () => {
  it("ignores a scroll while the pointer is elsewhere", () => {
    const { controller } = harness();
    controller.scroll();
    expect(controller.suppressionSource()).toBeNull();
  });

  it("engages on a scroll under a cursor that never moved", () => {
    const { controller } = harness();
    controller.pointerEnter({ ...MOUSE, clientX: 0, clientY: 0, timeStamp: 0 });
    controller.scroll();
    expect(controller.suppressionSource()).toBe("scroll");
  });

  it("arms itself from a move alone, for a list that mounts under a resting cursor", () => {
    const { controller } = harness();
    move(controller, 0, 0, 0);
    controller.scroll();
    expect(controller.suppressionSource()).toBe("scroll");
  });

  it("cannot be released by pointer samples", () => {
    const { controller, settled } = harness();
    controller.pointerEnter({ ...MOUSE, clientX: 0, clientY: 0, timeStamp: 0 });
    controller.scroll();
    // Stray near-stationary samples: under pointer authority these would home
    // in and release, which mid-scroll would strobe the list.
    move(controller, 0, 0, 100);
    move(controller, 0, 1, 108);
    move(controller, 0, 1, 116);
    expect(controller.suppressionSource()).toBe("scroll");
    expect(settled).toEqual([]);
  });

  it("takes over a pointer episode and settles as a scroll", async () => {
    vi.useFakeTimers();
    const { controller, settled } = harness();
    engagePointer(controller);
    expect(controller.suppressionSource()).toBe("pointer");
    controller.scroll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toEqual(["scroll"]);
  });

  it("keeps re-arming its backstop for as long as the list is moving", async () => {
    vi.useFakeTimers();
    const { controller, settled } = harness();
    controller.pointerEnter({ ...MOUSE, clientX: 0, clientY: 0, timeStamp: 0 });
    for (let i = 0; i < 6; i += 1) {
      controller.scroll();
      await vi.advanceTimersByTimeAsync(20);
      expect(settled).toEqual([]);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toEqual(["scroll"]);
  });
});
