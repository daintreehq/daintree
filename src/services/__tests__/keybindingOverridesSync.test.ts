// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeybindingOverridesSnapshot } from "@shared/types/ipc/api";

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
 * Main as the keybinding handlers run it: one saved map for the machine, each
 * save numbered and pushed to every subscribed view, and each write answered
 * with its save. `hold` keeps the next reply back and `deferPushes` keeps
 * pushes back, so a test can order replies and pushes either way round, as
 * the two travel separately in Electron.
 */
function createMain() {
  let saved: Overrides = {};
  let revision = 0;
  const listeners = new Set<(snapshot: KeybindingOverridesSnapshot) => void>();
  const heldReplies: Array<() => void> = [];
  const heldPushes: Array<{ revision: number; deliver: () => void }> = [];
  let holdNext = false;
  let deferring = false;

  const save = (next: Overrides): KeybindingOverridesSnapshot => {
    saved = next;
    revision += 1;
    const snapshot = { revision, overrides: next };
    for (const listener of Array.from(listeners)) {
      const pushed = { revision, overrides: { ...next } };
      const deliver = () => listener(pushed);
      if (deferring) heldPushes.push({ revision, deliver });
      else deliver();
    }
    return snapshot;
  };
  const reply = <T>(value: T): Promise<T> => {
    if (!holdNext) return Promise.resolve(value);
    holdNext = false;
    return new Promise((resolve) => heldReplies.push(() => resolve(value)));
  };

  const bridge = {
    getOverrides: vi.fn(() => reply({ revision, overrides: { ...saved } })),
    setOverride: vi.fn((actionId: string, combo: string[]) =>
      reply(save({ ...saved, [actionId]: combo }))
    ),
    removeOverride: vi.fn((actionId: string) => {
      const next = { ...saved };
      delete next[actionId];
      return reply(save(next));
    }),
    resetAll: vi.fn(() => reply(save({}))),
    onOverridesChanged: vi.fn((listener: (snapshot: KeybindingOverridesSnapshot) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };

  return {
    bridge,
    hold: () => {
      holdNext = true;
    },
    release: () => heldReplies.shift()?.(),
    deferPushes: () => {
      deferring = true;
    },
    /** Delivers the held pushes up to `upTo`; with no bound, all of them, and stops holding. */
    deliverPushes: (upTo = Infinity) => {
      if (upTo === Infinity) deferring = false;
      const due = heldPushes.filter((push) => push.revision <= upTo);
      heldPushes.splice(0, heldPushes.length, ...heldPushes.filter((push) => push.revision > upTo));
      due.forEach((push) => push.deliver());
    },
    /** A save made by a view this test doesn't model, pushed to every view. */
    saveElsewhere: (next: Overrides) => {
      save(next);
    },
    /** A save this view's listener never heard. */
    saveUnheard: (next: Overrides) => {
      saved = next;
      revision += 1;
    },
    listenerCount: () => listeners.size,
  };
}

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

const cmdW = () => keydown({ key: "w", code: "KeyW", metaKey: true });
const cmdK = () => keydown({ key: "k", code: "KeyK", metaKey: true });
const cmdShiftJ = () => keydown({ key: "j", code: "KeyJ", metaKey: true, shiftKey: true });

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalElectron = Object.getOwnPropertyDescriptor(window, "electron");

function restore(target: object, key: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

describe("keybinding overrides sync across views (#15579)", () => {
  let main: ReturnType<typeof createMain>;
  let writer: KeybindingService;
  let other: KeybindingService;
  const disposers: Array<() => void> = [];

  const connect = (service: KeybindingService) => {
    disposers.push(initKeybindingOverridesSync(service));
    return service;
  };
  const disconnectAll = () => disposers.splice(0).forEach((dispose) => dispose());

  beforeEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "MacIntel" },
      configurable: true,
      writable: true,
    });
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
    disconnectAll();
    vi.restoreAllMocks();
    restore(globalThis, "navigator", originalNavigator);
    restore(window, "electron", originalElectron);
  });

  it("gives every view a shortcut one view assigned, and tells its subscribers", async () => {
    const seen: Array<string | undefined> = [];
    other.subscribe(() => seen.push(other.getEffectiveCombo("terminal.close")));
    expect(other.findMatchingAction(cmdShiftJ())?.actionId).not.toBe("terminal.close");

    await writer.setOverride("terminal.close", ["Cmd+Shift+J"]);

    expect(other.findMatchingAction(cmdShiftJ())?.actionId).toBe("terminal.close");
    expect(seen).toEqual(["Cmd+Shift+J"]);
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

  it("takes the merged map an import saved without reading it again", async () => {
    await writer.setOverride("nav.quickSwitcher", ["Cmd+Shift+P"]);
    main.bridge.getOverrides.mockClear();

    // The import handler saves the existing map merged with the profile's.
    main.saveElsewhere({ "nav.quickSwitcher": ["Cmd+Shift+P"], "terminal.close": ["Cmd+Shift+J"] });

    for (const view of [writer, other]) {
      expect(view.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J");
      expect(view.getEffectiveCombo("nav.quickSwitcher")).toBe("Cmd+Shift+P");
    }
    expect(main.bridge.getOverrides).not.toHaveBeenCalled();
  });

  it("keeps a pushed map when a read that set out before it answers late", async () => {
    main.hold();
    const read = other.loadOverrides();

    await writer.setOverride("terminal.close", ["Cmd+Shift+J"]);
    main.release();
    await read;

    expect(other.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J");
  });

  it("takes a read that set out after the latest push", async () => {
    main.saveElsewhere({ "terminal.close": ["Cmd+Shift+J"] });
    main.saveUnheard({ "terminal.close": ["Cmd+Shift+K"] });

    await other.loadOverrides();

    expect(other.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+K");
  });

  it.each([
    ["set", (view: KeybindingService) => view.setOverride("terminal.close", ["Cmd+Shift+L"])],
    ["remove", (view: KeybindingService) => view.removeOverride("terminal.close")],
    ["reset all", (view: KeybindingService) => view.resetAllOverrides()],
  ])(
    "doesn't let a %s reply that comes last undo another view's later save",
    async (_kind, write) => {
      await writer.setOverride("terminal.close", ["Cmd+Shift+J"]);

      main.hold();
      const pending = write(writer);
      // Another view's save lands in Main after this write, before its reply.
      main.saveElsewhere({ "terminal.close": ["Cmd+Shift+K"] });
      main.release();
      await pending;

      for (const view of [writer, other]) {
        expect(view.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+K");
      }
    }
  );

  it.each([
    [
      "set",
      (view: KeybindingService) => view.setOverride("terminal.close", ["Cmd+Shift+L"]),
      "Cmd+Shift+L",
    ],
    ["remove", (view: KeybindingService) => view.removeOverride("terminal.close"), "Cmd+W"],
    ["reset all", (view: KeybindingService) => view.resetAllOverrides(), "Cmd+W"],
  ])(
    "shows a %s as soon as it resolves, when its reply beats its own push",
    async (_kind, write, expected) => {
      await writer.setOverride("terminal.close", ["Cmd+Shift+J"]);
      main.deferPushes();
      main.saveElsewhere({ "terminal.close": ["Cmd+Shift+K"], "nav.quickSwitcher": [] });
      const pending = write(writer);
      // Another view's earlier save reaches this one while the write travels;
      // the write's own push is still on its way when the reply lands.
      main.deliverPushes(2);
      await pending;

      expect(writer.getEffectiveCombo("terminal.close")).toBe(expected);
      main.deliverPushes();
      expect(writer.getEffectiveCombo("terminal.close")).toBe(expected);
      expect(other.getEffectiveCombo("terminal.close")).toBe(expected);
    }
  );

  it("applies a write's own save in a view that isn't listening for pushes", async () => {
    disconnectAll();

    await writer.setOverride("terminal.close", ["Cmd+Shift+J"]);
    expect(writer.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J");
    await writer.removeOverride("terminal.close");
    expect(writer.hasOverride("terminal.close")).toBe(false);
  });

  it("ignores the boot payload once a push has landed", () => {
    main.saveElsewhere({ "terminal.close": ["Cmd+Shift+J"] });

    other.applyBootOverrides({});

    expect(other.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J");
  });

  it("ignores the boot payload once a read has landed", async () => {
    main.saveUnheard({ "terminal.close": ["Cmd+Shift+J"] });
    await other.loadOverrides();

    other.applyBootOverrides({});

    expect(other.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J");
  });

  it("applies the boot payload when nothing newer was heard", () => {
    other.applyBootOverrides({ "terminal.close": ["Cmd+Shift+J"] });

    expect(other.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J");
  });

  it("drops a pending chord when the map changes, and keeps it when a push changes nothing", () => {
    main.saveElsewhere({ "terminal.close": ["Cmd+Shift+J"], "nav.quickSwitcher": ["F1", "F2"] });
    const startChord = () => {
      other.clearPendingChord();
      other.resolveKeybinding(cmdK());
      expect(other.getPendingChord()).not.toBeNull();
    };

    startChord();
    main.saveElsewhere({ "terminal.close": ["Cmd+Shift+J"], "nav.quickSwitcher": ["F1", "F2"] });
    expect(other.getPendingChord()).not.toBeNull();

    const changes: Overrides[] = [
      { "terminal.close": ["Cmd+Shift+K"], "nav.quickSwitcher": ["F1", "F2"] },
      { "terminal.close": ["Cmd+Shift+K"], "nav.quickSwitcher": ["F1"] },
      { "terminal.close": ["Cmd+Shift+K"], "nav.focusRegion.next": ["F1"] },
      { "terminal.close": ["Cmd+Shift+K"] },
    ];
    for (const change of changes) {
      startChord();
      main.saveElsewhere(change);
      expect(other.getPendingChord()).toBeNull();
    }
  });

  it("drops a pushed override for an action this view doesn't know", () => {
    main.saveElsewhere({ "terminal.close": ["Cmd+Shift+J"], "not.a.real.action": ["Cmd+J"] });

    expect(other.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J");
    expect(other.getOverride("not.a.real.action")).toBeUndefined();
  });

  it("reads the map again when a cached view comes back", async () => {
    main.saveUnheard({ "terminal.close": ["Cmd+Shift+J"] });

    lifecycle.emit("cached");
    expect(main.bridge.getOverrides).not.toHaveBeenCalled();
    lifecycle.emit("active");
    await vi.waitFor(() => expect(other.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J"));
  });

  it("reads the map when a service is attached again after a dispose", async () => {
    expect(main.bridge.getOverrides).not.toHaveBeenCalled();
    disconnectAll();
    main.saveElsewhere({ "terminal.close": ["Cmd+Shift+J"] });

    connect(other);

    await vi.waitFor(() => expect(other.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+J"));
  });

  it("doesn't let a reply from before a re-attach undo the save its read picked up", async () => {
    disconnectAll();
    main.hold();
    const pending = writer.setOverride("terminal.close", ["Cmd+Shift+J"]);
    // Saved while this view wasn't listening, so only the read can bring it.
    main.saveElsewhere({ "terminal.close": ["Cmd+Shift+K"] });
    connect(writer);
    await vi.waitFor(() => expect(writer.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+K"));

    main.release();
    await pending;

    expect(writer.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+K");
  });

  it("stops listening once disposed", () => {
    disconnectAll();
    expect(main.listenerCount()).toBe(0);
    expect(lifecycle.count()).toBe(0);

    main.saveElsewhere({ "terminal.close": [] });
    expect(other.hasOverride("terminal.close")).toBe(false);
  });

  it("does nothing on a bridge without the push", () => {
    disconnectAll();
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
