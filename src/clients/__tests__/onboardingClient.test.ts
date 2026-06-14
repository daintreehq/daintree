import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const typedGlobal = globalThis as unknown as Record<string, unknown>;

let getOnboardingState: typeof import("../onboardingClient").getOnboardingState;
let getMock: ReturnType<typeof vi.fn>;

describe("getOnboardingState", () => {
  beforeEach(async () => {
    vi.resetModules();

    getMock = vi.fn().mockResolvedValue({ completed: true, waitingNudgeSeen: false });
    typedGlobal.window = {
      electron: {
        onboarding: { get: getMock },
      },
    };

    const mod = await import("../onboardingClient");
    getOnboardingState = mod.getOnboardingState;
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  it("dedupes same-tick callers into a single IPC fetch", async () => {
    const a = getOnboardingState();
    const b = getOnboardingState();

    expect(b).toBe(a);
    expect(getMock).toHaveBeenCalledTimes(1);
    await expect(a).resolves.toEqual({ completed: true, waitingNudgeSeen: false });
  });

  it("refetches once the microtask checkpoint has passed", async () => {
    const first = getOnboardingState();
    await first;

    const second = getOnboardingState();
    expect(second).not.toBe(first);
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it("propagates rejections to all same-tick callers and clears the cache", async () => {
    getMock.mockRejectedValueOnce(new Error("IPC down"));

    const a = getOnboardingState();
    const b = getOnboardingState();
    await expect(a).rejects.toThrow("IPC down");
    await expect(b).rejects.toThrow("IPC down");

    getMock.mockResolvedValueOnce({ completed: false, waitingNudgeSeen: true });
    await expect(getOnboardingState()).resolves.toEqual({
      completed: false,
      waitingNudgeSeen: true,
    });
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});
