import { vi } from "vitest";
import type { PaintSurface } from "../PaintSurfaceRegistry";
import type { TerminalPaintPlane } from "../../TerminalInstanceService";
import type { ManagedTerminal } from "../../types";

// A stub TerminalPaintPlane covering every member the compositor tests
// exercise. `notifyScrollbackRestoreListeners` is wired to the listeners the
// fake accepted, so tests can simulate a plane-internal notification (the
// destroy-during-restore path) by calling it directly on the fake.
export function makeFakePlane() {
  const scrollbackListeners = new Set<() => void>();
  return {
    getOrCreate: vi.fn(async (id: string) => ({ id }) as unknown as ManagedTerminal),
    prewarmTerminal: vi.fn(async (id: string) => ({ id }) as unknown as ManagedTerminal),
    get: vi.fn((_id: string): ManagedTerminal | null => null),
    destroy: vi.fn(),
    dispose: vi.fn(),
    focus: vi.fn(),
    notifyUserInput: vi.fn(),
    notifyEnterPressed: vi.fn(),
    clearDirectingState: vi.fn(),
    applyGlobalOptions: vi.fn(),
    updateOptions: vi.fn(),
    suppressResizesDuringLayoutTransition: vi.fn(),
    waitForAllFullySettled: vi.fn(async () => undefined),
    scheduleBatchResize: vi.fn(),
    runResizePass: vi.fn(),
    cancelActiveResizePass: vi.fn(),
    subscribeScrollbackRestoreState: vi.fn((listener: () => void) => {
      scrollbackListeners.add(listener);
      return () => scrollbackListeners.delete(listener);
    }),
    notifyScrollbackRestoreListeners: vi.fn(() => {
      scrollbackListeners.forEach((listener) => listener());
    }),
    getScrollbackRestorePendingCount: vi.fn(() => 0),
    getScrollbackRestoreInProgressCount: vi.fn(() => 0),
    getScrollbackRestoreTotalCount: vi.fn(() => 0),
    subscribeUnseenOutput: vi.fn(() => vi.fn()),
    subscribeHibernation: vi.fn(() => vi.fn()),
    addAgentStateListener: vi.fn(() => vi.fn()),
    addExitListener: vi.fn(() => vi.fn()),
    addAltBufferListener: vi.fn(() => vi.fn()),
    registerPostCompleteHook: vi.fn(() => vi.fn()),
    unregisterPostCompleteHook: vi.fn(),
    fetchAndRestore: vi.fn(async () => true),
    getAgentState: vi.fn(() => undefined),
    isFocused: vi.fn(() => false),
    setAgentState: vi.fn(),
    setFocused: vi.fn(),
    setVisible: vi.fn(),
    initializeBackendTier: vi.fn(),
    applyRendererPolicy: vi.fn(),
    applyAgentPromotion: vi.fn(),
    clearAgentPromotion: vi.fn(),
    setInputLocked: vi.fn(),
    setGPUHardwareAvailable: vi.fn(),
    getWebGLStateForE2E: vi.fn(() => ({ wantsSize: 0, active: false, mode: "webgl" })),
    triggerTerminalLinkForE2E: vi.fn(),
    getInstanceForE2E: vi.fn(() => undefined),
  };
}

export type FakePlane = ReturnType<typeof makeFakePlane>;

export function makeSurface(id: string): { surface: PaintSurface; plane: FakePlane } {
  const plane = makeFakePlane();
  return { surface: { id, plane: plane as unknown as TerminalPaintPlane }, plane };
}
