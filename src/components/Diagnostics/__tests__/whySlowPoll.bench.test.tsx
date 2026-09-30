// @vitest-environment jsdom
/**
 * Benchmark: renderer-driven IPC load from the "Why is it slow?" poll and the
 * tour invitation's focus refresh. Counts round-trips at the IPC boundary
 * under fake timers and prints a table; the assertions pin the gated result.
 * The tour half runs through the real onboarding client, whose same-tick
 * dedupe is part of what is measured.
 *
 *   npx vitest run src/components/Diagnostics/__tests__/whySlowPoll.bench.test.tsx
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WhySlowSnapshot } from "@shared/types/whySlow";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";

const { getWhySlowSnapshot } = vi.hoisted(() => ({ getWhySlowSnapshot: vi.fn() }));
vi.mock("@/clients/systemClient", () => ({ systemClient: { getWhySlowSnapshot } }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { WhySlowContent } from "../WhySlowContent";
import { TourInviteCard } from "@/components/Tour/TourInviteCard";
import { DAINTREE_TOUR_ID } from "@shared/utils/tourIds";

const MINUTE = 60_000;
const onboardingGet = vi.fn();

let visibility: DocumentVisibilityState = "visible";
let cachedHandlers: Set<() => void>;
let warmHandlers: Set<() => void>;
let revealedHandlers: Set<() => void>;

function onboarding() {
  return {
    tours: { [DAINTREE_TOUR_ID]: { completed: false, dismissed: false, lastChapter: 0 } },
    tourMuted: false,
  };
}

function snapshot(): WhySlowSnapshot {
  return {
    timestamp: Date.now(),
    resource: null,
    focusThrottle: { throttled: false, pollMultiplier: 1 },
    rendererTerminals: [],
    pty: null,
    worktrees: null,
    workers: null,
    memory: null,
  };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

const emitAll = (handlers: Set<() => void>) => handlers.forEach((h) => h());

const results: Array<[string, number]> = [];
beforeAll(() => {
  results.length = 0;
});
afterAll(() => {
  process.stdout.write("\nBENCH\n" + results.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n");
});

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "hidden", {
    get: () => visibility === "hidden",
    configurable: true,
  });
  Object.defineProperty(document, "visibilityState", {
    get: () => visibility,
    configurable: true,
  });
  cachedHandlers = new Set();
  warmHandlers = new Set();
  revealedHandlers = new Set();
  const sub = (set: Set<() => void>) => (cb: () => void) => {
    set.add(cb);
    return () => set.delete(cb);
  };
  vi.stubGlobal("electron", {
    app: {
      onViewCached: sub(cachedHandlers),
      onViewWarmActivated: sub(warmHandlers),
      onViewRevealed: sub(revealedHandlers),
      isViewCached: () => false,
    },
    onboarding: { get: onboardingGet, dismissTourInvite: vi.fn() },
  });
  __resetProjectViewCacheStateForTests();
  getWhySlowSnapshot.mockReset();
  getWhySlowSnapshot.mockImplementation(() => Promise.resolve(snapshot()));
  onboardingGet.mockReset();
  onboardingGet.mockImplementation(() => Promise.resolve(onboarding()));
});

afterEach(() => {
  __resetProjectViewCacheStateForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "hidden");
  Reflect.deleteProperty(document, "visibilityState");
});

/** Snapshot IPCs in one minute after the given suppression is applied. */
async function snapshotCallsPerMinute(suppress: () => void): Promise<number> {
  const view = render(<WhySlowContent />);
  await advance(0);
  act(suppress);
  await advance(0);
  const before = getWhySlowSnapshot.mock.calls.length;
  await advance(MINUTE);
  const calls = getWhySlowSnapshot.mock.calls.length - before;
  view.unmount();
  return calls;
}

describe("why-slow poll benchmark", () => {
  it("visible: snapshot IPCs / min", async () => {
    const n = await snapshotCallsPerMinute(() => {});
    results.push(["why-slow visible — snapshot IPCs/min", n]);
    expect(n).toBe(12);
  });

  it("window hidden: snapshot IPCs / min", async () => {
    const n = await snapshotCallsPerMinute(() => setVisibility("hidden"));
    results.push(["why-slow window hidden — snapshot IPCs/min", n]);
    expect(n).toBe(0);
  });

  it("project view cached: snapshot IPCs / min", async () => {
    const n = await snapshotCallsPerMinute(() => emitAll(cachedHandlers));
    results.push(["why-slow view cached — snapshot IPCs/min", n]);
    expect(n).toBe(0);
  });

  it("reads afresh on resume when a read from before the pause is still out", async () => {
    render(<WhySlowContent />);
    await advance(0);
    let release: () => void = () => {};
    getWhySlowSnapshot.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(snapshot())))
    );
    await advance(5_000);
    act(() => setVisibility("hidden"));
    await advance(2_000);
    act(() => setVisibility("visible"));
    const before = getWhySlowSnapshot.mock.calls.length;
    await advance(0);
    expect(getWhySlowSnapshot.mock.calls.length - before).toBe(0);
    release();
    await advance(0);
    expect(getWhySlowSnapshot.mock.calls.length - before).toBe(1);
  });

  it("resumes from a cached view on warm activation, once", async () => {
    render(<WhySlowContent />);
    await advance(0);
    act(() => emitAll(cachedHandlers));
    await advance(MINUTE);
    const before = getWhySlowSnapshot.mock.calls.length;
    // `active` then `revealed` is one resume, not two.
    act(() => {
      emitAll(warmHandlers);
      emitAll(revealedHandlers);
    });
    await advance(0);
    expect(getWhySlowSnapshot.mock.calls.length - before).toBe(1);
    await advance(MINUTE);
    expect(getWhySlowSnapshot.mock.calls.length - before).toBe(13);
  });

  it("refreshes once, immediately, when shown again", async () => {
    render(<WhySlowContent />);
    await advance(0);
    act(() => setVisibility("hidden"));
    await advance(MINUTE + 2_500);
    const before = getWhySlowSnapshot.mock.calls.length;
    act(() => setVisibility("visible"));
    await advance(0);
    const onShow = getWhySlowSnapshot.mock.calls.length - before;
    results.push(["why-slow snapshots at the instant of re-show", onShow]);
    // Cadence resumes from the re-show.
    await advance(5_000);
    expect(getWhySlowSnapshot.mock.calls.length - before).toBe(2);
    expect(onShow).toBe(1);
  });
});

describe("tour invitation focus benchmark", () => {
  /** onboarding:get IPCs for one return to the window, first reply held in flight. */
  async function callsFor(minimize: boolean, ret: () => Promise<void>): Promise<number> {
    const view = render(<TourInviteCard />);
    await advance(0);
    act(() => {
      window.dispatchEvent(new Event("blur"));
      if (minimize) setVisibility("hidden");
    });
    let release: () => void = () => {};
    onboardingGet.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(onboarding())))
    );
    const before = onboardingGet.mock.calls.length;
    await act(ret);
    release();
    await advance(0);
    const calls = onboardingGet.mock.calls.length - before;
    view.unmount();
    return calls;
  }

  // Chromium dispatches each native event separately, draining microtasks in
  // between, so the client's same-tick dedupe can't join the two.
  const boundary = () => Promise.resolve().then(() => Promise.resolve());

  it("restore from minimized (visibilitychange, then focus): onboarding:get IPCs", async () => {
    const n = await callsFor(true, async () => {
      setVisibility("visible");
      await boundary();
      window.dispatchEvent(new Event("focus"));
      await boundary();
    });
    results.push(["tour card — onboarding:get IPCs per restore", n]);
    expect(n).toBe(1);
  });

  it("switching back from another app (focus only): onboarding:get IPCs", async () => {
    const n = await callsFor(false, async () => {
      window.dispatchEvent(new Event("focus"));
      await boundary();
    });
    results.push(["tour card — onboarding:get IPCs per plain refocus", n]);
    expect(n).toBe(1);
  });
});
