// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TerminalAttachRecoveryController,
  type TerminalAttachRecoveryControllerDeps,
} from "../TerminalAttachRecoveryController";
import type { ManagedTerminal } from "../types";

const harness = vi.hoisted(() => {
  const constructed: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  class XtermFake {
    dispose = vi.fn();
    options = {};
    constructor() {
      constructed.push(this);
    }
  }
  // Addon setup resolves at once unless a test holds it to land a change
  // during the await.
  const addons = {
    hold: false,
    release: undefined as (() => void) | undefined,
  };
  return { constructed, XtermFake, addons };
});

vi.mock("../xtermCore", () => ({
  loadXtermCore: vi.fn(async () => ({ Terminal: harness.XtermFake })),
}));

vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(
    () =>
      new Promise((resolve) => {
        const release = () => resolve({ fitAddon: {}, serializeAddon: {} });
        if (harness.addons.hold) harness.addons.release = release;
        else release();
      })
  ),
}));

vi.mock("../TerminalParserHandler", () => ({
  TerminalParserHandler: class {
    dispose = vi.fn();
  },
}));

const installTerminalBoundListeners = vi.hoisted(() => vi.fn());
vi.mock("../TerminalListenerInstaller", () => ({ installTerminalBoundListeners }));

vi.mock("../TerminalReflowController", () => ({ resetRendererUnpauseBreaker: vi.fn() }));
vi.mock("../terminalLinkTooltip", () => ({ hideTerminalLinkTooltip: vi.fn() }));
vi.mock("@shared/utils/xtermReflowFastpath", () => ({ applyXtermReflowFastpath: vi.fn() }));

const setTerminalAttachError = vi.hoisted(() => vi.fn());
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({ setTerminalAttachError, clearTerminalAttachError: vi.fn() }),
  },
}));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

function makeManaged(id: string): ManagedTerminal {
  return {
    id,
    terminal: {
      options: {},
      write: vi.fn((_data: string, callback?: () => void) => callback?.()),
      dispose: vi.fn(),
    },
    hostElement: document.createElement("div"),
    listeners: [],
    ipcListenerCount: 0,
    pendingWrites: 0,
    isOpened: false,
    lastAttachError: "open failed",
    latestCols: 0,
    latestRows: 0,
  } as unknown as ManagedTerminal;
}

describe("TerminalAttachRecoveryController", () => {
  let instances: Map<string, ManagedTerminal>;
  let deps: TerminalAttachRecoveryControllerDeps;
  let controller: TerminalAttachRecoveryController;

  beforeEach(() => {
    vi.clearAllMocks();
    harness.constructed.length = 0;
    harness.addons.hold = false;
    harness.addons.release = undefined;
    instances = new Map();
    deps = {
      getInstance: (id) => instances.get(id),
      hostHasRenderableDims: () => true,
      ensureOpened: vi.fn(),
      sharedOptions: vi.fn(() => ({
        rescaleOverlappingGlyphs: true as const,
        linkHandler: { activate: vi.fn() },
      })),
      makeListenerInstallDeps: vi.fn(),
      applyDeferredResize: vi.fn(),
      drawDataLossMarker: vi.fn(),
      cancelAttachReveal: vi.fn(),
      clearResizeJob: vi.fn(),
      clearSettledTimer: vi.fn(),
      forgetWrites: vi.fn(),
      cancelWebGLHideTimer: vi.fn(),
      onWebGLTerminalDestroyed: vi.fn(),
      rebindWorkerIngest: vi.fn(),
      reseedMirrorGeometry: vi.fn(),
      applyRendererPolicy: vi.fn(),
      fit: vi.fn(),
      fetchAndRestore: vi.fn(async () => true),
      notifyAttachSettled: vi.fn(),
    };
    controller = new TerminalAttachRecoveryController(deps);
  });

  afterEach(() => {
    instances.clear();
  });

  it.each([
    ["destroyed", (id: string) => instances.delete(id)],
    ["replaced", (id: string) => instances.set(id, makeManaged(id))],
  ])("leaves a terminal %s mid-drain untouched", async (_label, unseat) => {
    const managed = makeManaged("drain");
    managed.pendingWrites = 1;
    let releaseDrain: (() => void) | undefined;
    const original = managed.terminal as unknown as {
      write: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    };
    original.write = vi.fn((_data: string, callback?: () => void) => {
      releaseDrain = () => {
        managed.pendingWrites = 0;
        callback?.();
      };
    });
    instances.set("drain", managed);

    const recovery = controller.recoverPoisonedTerminal("drain", { manual: true });
    await vi.waitFor(() => expect(releaseDrain).toBeDefined());
    unseat("drain");
    releaseDrain?.();

    await expect(recovery).resolves.toBe(false);
    // One attempt: the loop must not go back for a terminal it no longer owns.
    expect(original.write).toHaveBeenCalledTimes(1);
    expect(deps.cancelAttachReveal).not.toHaveBeenCalled();
    expect(deps.onWebGLTerminalDestroyed).not.toHaveBeenCalled();
    expect(original.dispose).not.toHaveBeenCalled();
    expect(harness.constructed).toHaveLength(0);
    // Nobody is left to show it to.
    expect(setTerminalAttachError).not.toHaveBeenCalled();
  });

  it("drops the replacement when the terminal is replaced while its addons load", async () => {
    const managed = makeManaged("addons");
    const original = managed.terminal as unknown as { write: ReturnType<typeof vi.fn> };
    instances.set("addons", managed);
    harness.addons.hold = true;

    const recovery = controller.recoverPoisonedTerminal("addons", { manual: true });
    await vi.waitFor(() => expect(harness.addons.release).toBeDefined());
    instances.set("addons", makeManaged("addons"));
    harness.addons.release?.();

    await expect(recovery).resolves.toBe(false);
    expect(original.write).toHaveBeenCalledTimes(1);
    expect(harness.constructed).toHaveLength(1);
    expect(harness.constructed[0]!.dispose).toHaveBeenCalled();
    expect(managed.terminal).toBe(original as unknown as ManagedTerminal["terminal"]);
    expect(deps.makeListenerInstallDeps).not.toHaveBeenCalled();
    expect(installTerminalBoundListeners).not.toHaveBeenCalled();
    expect(deps.ensureOpened).not.toHaveBeenCalled();
    expect(setTerminalAttachError).not.toHaveBeenCalled();
  });
});
