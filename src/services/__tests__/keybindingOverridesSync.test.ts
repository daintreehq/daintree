// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => {
  const listeners = new Set<(phase: string) => void>();
  return {
    subscribeProjectViewLifecycle: (listener: (phase: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (phase: string) => listeners.forEach((listener) => listener(phase)),
    count: () => listeners.size,
  };
});

vi.mock("@/lib/viewCacheState", () => ({
  subscribeProjectViewLifecycle: lifecycle.subscribeProjectViewLifecycle,
}));

import { KeybindingService } from "../KeybindingService";
import { initKeybindingOverridesSync } from "../keybindingOverridesSync";

type Overrides = Record<string, string[]>;

/**
 * Main as the keybinding handlers run it: one saved map for the machine, and
 * every write pushed to every subscribed view before its reply. `hold` keeps a
 * call's reply back so a test can land other traffic first.
 */
function createMain(initial: Overrides = {}) {
  let saved: Overrides = { ...initial };
  const listeners = new Set<(overrides: Overrides) => void>();
  const held: Array<() => void> = [];
  let holdNext = false;

  const save = (next: Overrides) => {
    saved = next;
    for (const listener of Array.from(listeners)) listener({ ...next });
  };
  const reply = <T>(value: T): Promise<T> => {
    if (!holdNext) return Promise.resolve(value);
    holdNext = false;
    return new Promise((resolve) => held.push(() => resolve(value)));
  };

  const bridge = {
    getOverrides: vi.fn(() => reply({ ...saved })),
    setOverride: vi.fn((actionId: string, combo: string[]) => {
      save({ ...saved, [actionId]: combo });
      return reply(undefined);
    }),
    removeOverride: vi.fn((actionId: string) => {
      const next = { ...saved };
      delete next[actionId];
      save(next);
      return reply(undefined);
    }),
    resetAll: vi.fn(() => {
      save({});
      return reply(undefined);
    }),
    importProfile: vi.fn((imported: Overrides) => {
      save({ ...saved, ...imported });
      return reply({ ok: true, overrides: imported, applied: 1, skipped: 0, errors: [] });
    }),
    onOverridesChanged: vi.fn((listener: (overrides: Overrides) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };

  return {
    bridge,
    /** Holds back the reply of the next call made through the bridge. */
    hold: () => {
      holdNext = true;
    },
    release: () => held.shift()?.(),
    /** A change saved by a view this test doesn't model. */
    saveElsewhere: save,
    /** A change saved while this view's listener couldn't hear it. */
    saveUnheard: (next: Overrides) => {
      saved = next;
    },
    listenerCount: () => listeners.size,
  };
}

function setPlatform(platform: string) {
  Object.defineProperty(globalThis, "navigator", {
    value: { platform },
    configurable: true,
    writable: true,
  });
}

function keydown(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  } as KeyboardEvent;
}

const cmdW = () => keydown({ key: "w", code: "KeyW", metaKey: true });
const cmdK = () => keydown({ key: "k", code: "KeyK", metaKey: true });
const cmdShiftJ = () => keydown({ key: "j", code: "KeyJ", metaKey: true, shiftKey: true });

describe("keybinding overrides sync across views (#15579)", () => {
  let main: ReturnType<typeof createMain>;
  let writer: KeybindingService;
  let other: KeybindingService;
  const disposers: Array<() => void> = [];

  const connect = (service: KeybindingService) => {
    disposers.push(initKeybindingOverridesSync(service));
    return service;
  };

  beforeEach(() => {
    setPlatform("MacIntel");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    main = createMain();
    Object.defineProperty(window, "electron", {
      value: { keybinding: main.bridge },
      configurable: true,
      writable: true,
    });
    writer = connect(new KeybindingService());
    other = connect(new KeybindingService());
  });

  afterEach(() => {
    disposers.splice(0).forEach((dispose) => dispose());
    vi.restoreAllMocks();
  });

  it("gives every view a shortcut one view assigned", async () => {
    expect(other.findMatchingAction(cmdShiftJ())?.actionId).not.toBe("terminal.close");

    await writer.setOverride("terminal.close", ["Cmd+Shift+J"]);

    expect(other.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J");
    expect(other.findMatchingAction(cmdShiftJ())?.actionId).toBe("terminal.close");
  });

  it("stops a shortcut one view cleared from running in another", async () => {
    expect(other.findMatchingAction(cmdW())?.actionId).toBe("terminal.close");

    await writer.setOverride("terminal.close", []);

    expect(other.findMatchingAction(cmdW())?.actionId).not.toBe("terminal.close");
    expect(other.getEffectiveCombo("terminal.close")).toBeUndefined();
  });

  it("puts the default back in every view when one view resets a shortcut", async () => {
    await writer.setOverride("terminal.close", ["Cmd+Shift+J"]);
    await writer.removeOverride("terminal.close");

    expect(other.hasOverride("terminal.close")).toBe(false);
    expect(other.findMatchingAction(cmdW())?.actionId).toBe("terminal.close");
  });

  it("clears every view's overrides on Reset all", async () => {
    await writer.setOverride("terminal.close", []);
    await writer.setOverride("nav.quickSwitcher", ["Cmd+Shift+J"]);

    await writer.resetAllOverrides();

    expect(other.hasOverride("terminal.close")).toBe(false);
    expect(other.hasOverride("nav.quickSwitcher")).toBe(false);
    expect(other.findMatchingAction(cmdW())?.actionId).toBe("terminal.close");
  });

  it("gives every view the merged map after a profile import", async () => {
    await writer.setOverride("nav.quickSwitcher", ["Cmd+Shift+P"]);
    main.bridge.getOverrides.mockClear();

    await main.bridge.importProfile({ "terminal.close": ["Cmd+Shift+J"] });
    await writer.loadOverrides();

    for (const view of [writer, other]) {
      expect(view.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J");
      expect(view.getEffectiveCombo("nav.quickSwitcher")).toBe("Cmd+Shift+P");
    }
    // The other view took the push; only the importing view read again.
    expect(main.bridge.getOverrides).toHaveBeenCalledTimes(1);
  });

  it("keeps a pushed map when a read that set out before it answers late", async () => {
    main.hold();
    const read = other.loadOverrides();

    await writer.setOverride("terminal.close", ["Cmd+Shift+J"]);
    main.release();
    await read;

    expect(other.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J");
  });

  it("ignores the boot payload once a push has landed", () => {
    main.saveElsewhere({ "terminal.close": ["Cmd+Shift+J"] });

    other.applyBootOverrides({});

    expect(other.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J");
  });

  it("applies the boot payload when nothing newer was heard", () => {
    other.applyBootOverrides({ "terminal.close": ["Cmd+Shift+J"] });

    expect(other.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J");
  });

  it("doesn't undo another view's later write when this view's reply comes last", async () => {
    await writer.setOverride("terminal.close", ["Cmd+Shift+J"]);

    main.hold();
    const removal = writer.removeOverride("terminal.close");
    // Another view's write lands in Main after the removal, before its reply.
    main.saveElsewhere({ "terminal.close": ["Cmd+Shift+K"] });
    main.release();
    await removal;

    for (const view of [writer, other]) {
      expect(view.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+K");
    }
  });

  it("drops a pending chord when the map changes, and keeps it when a push changes nothing", () => {
    other.resolveKeybinding(cmdK());
    expect(other.getPendingChord()).not.toBeNull();

    main.saveElsewhere({});
    expect(other.getPendingChord()).not.toBeNull();

    main.saveElsewhere({ "terminal.close": [] });
    expect(other.getPendingChord()).toBeNull();
  });

  it("reads the map again when a cached view comes back", async () => {
    main.saveUnheard({ "terminal.close": ["Cmd+Shift+J"] });

    lifecycle.emit("cached");
    expect(main.bridge.getOverrides).not.toHaveBeenCalled();
    lifecycle.emit("active");
    await vi.waitFor(() => expect(other.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J"));
  });

  it("stops listening once disposed", () => {
    disposers.splice(0).forEach((dispose) => dispose());
    expect(main.listenerCount()).toBe(0);
    expect(lifecycle.count()).toBe(0);

    main.saveElsewhere({ "terminal.close": [] });
    expect(other.hasOverride("terminal.close")).toBe(false);
  });

  it("does nothing on a bridge without the push", () => {
    disposers.splice(0).forEach((dispose) => dispose());
    Object.defineProperty(window, "electron", {
      value: { keybinding: { getOverrides: vi.fn() } },
      configurable: true,
      writable: true,
    });
    const dispose = initKeybindingOverridesSync(new KeybindingService());
    expect(lifecycle.count()).toBe(0);
    dispose();
  });
});
