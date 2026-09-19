// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import type { ManagedTerminal } from "../types";
import { WRITE_BURST_DECAY_MS } from "../types";
import {
  TerminalBurstController,
  type TerminalBurstControllerDeps,
} from "../TerminalBurstController";

function makeManaged(tier: TerminalRefreshTier): ManagedTerminal {
  return {
    getRefreshTier: () => tier,
  } as unknown as ManagedTerminal;
}

describe("TerminalBurstController write burst", () => {
  let managed: ManagedTerminal;
  let applyRendererPolicy: ReturnType<
    typeof vi.fn<(id: string, tier: TerminalRefreshTier) => void>
  >;
  let cached: boolean;
  let controller: TerminalBurstController;

  beforeEach(() => {
    vi.useFakeTimers();
    cached = false;
    managed = makeManaged(TerminalRefreshTier.VISIBLE);
    applyRendererPolicy = vi.fn();
    controller = new TerminalBurstController({
      getInstance: () => managed,
      applyRendererPolicy,
      isViewCached: () => cached,
      holdWebGLForScroll: vi.fn(),
    });
  });

  afterEach(() => {
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

describe("TerminalBurstController — scroll boosts stay terminal-scoped (#12518)", () => {
  let instances: Map<string, ManagedTerminal>;
  let deps: {
    getInstance: TerminalBurstControllerDeps["getInstance"];
    applyRendererPolicy: Mock<TerminalBurstControllerDeps["applyRendererPolicy"]>;
    holdWebGLForScroll: Mock<TerminalBurstControllerDeps["holdWebGLForScroll"]>;
  };
  let controller: TerminalBurstController;

  beforeEach(() => {
    vi.useFakeTimers();
    // An empty system namespace: any IPC to the main process would throw.
    (window as unknown as { electron: unknown }).electron = { system: {} };
    instances = new Map([["t1", makeManaged(TerminalRefreshTier.FOCUSED)]]);
    deps = {
      getInstance: (id) => instances.get(id),
      applyRendererPolicy: vi.fn<TerminalBurstControllerDeps["applyRendererPolicy"]>(),
      holdWebGLForScroll: vi.fn<TerminalBurstControllerDeps["holdWebGLForScroll"]>(),
    };
    controller = new TerminalBurstController(deps);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it("holds the scrolled terminal's WebGL context for the gesture on scrollback scroll", () => {
    controller.onUserScrollIntent("t1");

    expect(deps.holdWebGLForScroll).toHaveBeenCalledWith("t1", 1000);
    expect(deps.applyRendererPolicy).not.toHaveBeenCalled();
  });

  it("renews the hold on every scroll event rather than throttling it", () => {
    controller.onUserScrollIntent("t1");
    controller.onUserScrollIntent("t1");
    controller.onUserScrollIntent("t1");

    expect(deps.holdWebGLForScroll).toHaveBeenCalledTimes(3);
  });

  it("ignores scroll intent for an unknown terminal", () => {
    controller.onUserScrollIntent("gone");

    expect(deps.holdWebGLForScroll).not.toHaveBeenCalled();
  });

  it("boosts an actively wheeled TUI to BURST and reverts after the gesture", () => {
    controller.onActiveWheel("t1");

    expect(deps.applyRendererPolicy).toHaveBeenLastCalledWith("t1", TerminalRefreshTier.BURST);
    expect(controller.isWheelActive("t1")).toBe(true);

    vi.advanceTimersByTime(1000);

    expect(deps.applyRendererPolicy).toHaveBeenLastCalledWith("t1", TerminalRefreshTier.FOCUSED);
    expect(controller.isWheelActive("t1")).toBe(false);
  });

  it("leaves the WebGL context of an actively wheeled TUI to its alt-buffer pin", () => {
    controller.onActiveWheel("t1");

    expect(deps.holdWebGLForScroll).not.toHaveBeenCalled();
  });
});
