import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import type { ManagedTerminal } from "../types";
import { WRITE_BURST_DECAY_MS } from "../types";

vi.mock("@/utils/safeFireAndForget", () => ({ safeFireAndForget: vi.fn() }));

import { TerminalBurstController } from "../TerminalBurstController";

describe("TerminalBurstController write burst", () => {
  let managed: ManagedTerminal;
  let applyRendererPolicy: ReturnType<
    typeof vi.fn<(id: string, tier: TerminalRefreshTier) => void>
  >;
  let cached: boolean;
  let controller: TerminalBurstController;

  beforeEach(() => {
    vi.useFakeTimers();
    // Burst timers are armed via window.setTimeout; the node env has no window.
    vi.stubGlobal("window", globalThis);
    cached = false;
    managed = {
      getRefreshTier: () => TerminalRefreshTier.VISIBLE,
    } as unknown as ManagedTerminal;
    applyRendererPolicy = vi.fn();
    controller = new TerminalBurstController({
      getInstance: () => managed,
      applyRendererPolicy,
      isViewCached: () => cached,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("promotes to BURST and decays back to the provider's tier", () => {
    controller.onPtyWrite("t1");

    expect(applyRendererPolicy).toHaveBeenCalledWith("t1", TerminalRefreshTier.BURST);
    vi.advanceTimersByTime(WRITE_BURST_DECAY_MS);
    expect(applyRendererPolicy).toHaveBeenLastCalledWith("t1", TerminalRefreshTier.VISIBLE);
  });

  it("does nothing for output in a cached view (#12514)", () => {
    cached = true;

    controller.onPtyWrite("t1");

    expect(applyRendererPolicy).not.toHaveBeenCalled();
    expect(managed.writeBurstTimer).toBeUndefined();
    expect(managed.writeBurstDeadline).toBeUndefined();
  });
});
