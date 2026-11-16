import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext, ActionSource } from "@shared/types/actions";
import type { ActionRegistry } from "../../actionTypes";

const toggleFocusedPanel = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const stopAndSend = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const toggle = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
// Stands in for the composer check: only these panes can take dictation.
const dictatable = vi.hoisted(() => new Set<string>());
const getDictationTarget = vi.hoisted(() =>
  vi.fn((panelId: string) =>
    dictatable.has(panelId) ? { panelId, panelTitle: `Pane ${panelId}` } : null
  )
);
// Null: nothing to stop in that panel.
const stopPanelDictation = vi.hoisted(() => vi.fn((): Promise<void> | null => null));
const adoptShortcutPress = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => {
  const service = {
    toggleFocusedPanel,
    stopAndSend,
    toggle,
    stopPanelDictation,
    adoptShortcutPress,
  };
  return {
    service,
    loaded: service as typeof service | null,
    // Runs while the service loads, as anything can.
    duringLoad: null as (() => void) | null,
    pendingPress: null as null | { code: string; released: boolean },
  };
});
vi.mock("@/services/voiceRecordingRuntime", () => ({
  loadVoiceRecordingService: vi.fn(async () => {
    runtime.duringLoad?.();
    runtime.loaded = runtime.service;
    return runtime.service;
  }),
  getLoadedVoiceRecordingService: () => runtime.loaded,
  takePendingVoiceShortcutPress: () => {
    const press = runtime.pendingPress;
    runtime.pendingPress = null;
    return press;
  },
}));
vi.mock("@/services/voiceDictationTarget", () => ({
  resolveDictationTarget: getDictationTarget,
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { notify } from "@/lib/notify";
import { usePanelStore } from "@/store/panelStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { registerVoiceActions } from "../voiceActions";

function runAction(id: string, args: unknown) {
  const actions: ActionRegistry = new Map();
  registerVoiceActions(actions);
  return actions.get(id as Parameters<ActionRegistry["get"]>[0])!().run(args, {} as ActionContext);
}

function runToggle(ctx: ActionContext | undefined) {
  const actions: ActionRegistry = new Map();
  registerVoiceActions(actions);
  const definition = actions.get("voiceInput.toggle")!();
  return definition.run(undefined, ctx as ActionContext);
}

describe("voiceInput.toggle (#14791)", () => {
  it("takes the person back to a dictation it stops only when the key itself pressed it", async () => {
    const sources: Array<ActionSource | undefined> = [
      "keybinding",
      "user",
      "menu",
      "context-menu",
      "agent",
      "plugin",
      undefined,
    ];
    for (const dispatchSource of sources) {
      toggleFocusedPanel.mockClear();
      await runToggle({ dispatchSource });
      expect(toggleFocusedPanel).toHaveBeenCalledWith({
        returnToTarget: dispatchSource === "keybinding",
      });
    }

    toggleFocusedPanel.mockClear();
    await runToggle(undefined);
    expect(toggleFocusedPanel).toHaveBeenCalledWith({ returnToTarget: false });
  });
});

describe("voiceInput.toggle loading the service (#17031)", () => {
  beforeEach(() => {
    runtime.loaded = null;
    runtime.pendingPress = null;
    adoptShortcutPress.mockClear();
    toggleFocusedPanel.mockClear();
  });

  it("hands the key's press to the service it loaded before the toggle claims it", async () => {
    const press = { code: "Period", released: false };
    runtime.pendingPress = press;

    await runToggle({ dispatchSource: "keybinding" } as ActionContext);

    expect(adoptShortcutPress).toHaveBeenCalledWith(press);
    expect(adoptShortcutPress.mock.invocationCallOrder[0]).toBeLessThan(
      toggleFocusedPanel.mock.invocationCallOrder[0]!
    );
    expect(runtime.pendingPress).toBeNull();
  });

  it("leaves a press alone when anything but the key dispatched the toggle", async () => {
    runtime.pendingPress = { code: "Period", released: false };

    await runToggle({ dispatchSource: "user" } as ActionContext);

    expect(adoptShortcutPress).not.toHaveBeenCalled();
    expect(toggleFocusedPanel).toHaveBeenCalledTimes(1);
  });
});

describe("voiceInput.stopAndSend (#14920)", () => {
  it("stops and sends from wherever it is pressed, never toggling a session", async () => {
    const actions: ActionRegistry = new Map();
    registerVoiceActions(actions);
    toggleFocusedPanel.mockClear();

    await actions.get("voiceInput.stopAndSend")!().run(undefined, {
      dispatchSource: "keybinding",
    } as ActionContext);

    // Asked by the action, not the session panel's button: the key's default asker.
    expect(stopAndSend).toHaveBeenCalledTimes(1);
    expect(stopAndSend).toHaveBeenCalledWith();
    expect(toggleFocusedPanel).not.toHaveBeenCalled();
  });
});

describe("dictation locks and recalls only a pane with a composer (#14955)", () => {
  beforeEach(() => {
    dictatable.clear();
    toggle.mockClear();
    stopPanelDictation.mockClear();
    runtime.loaded = runtime.service;
    runtime.duringLoad = null;
    useVoiceRecordingStore.getState().setLastError(null);
    vi.mocked(notify).mockClear();
    useVoiceRecordingStore.getState().unlockTarget();
    usePanelStore.setState({ focusedId: null });
  });

  it("locks to a pane that can show the words, named or focused", async () => {
    dictatable.add("agent-1").add("agent-2");

    await runAction("voiceInput.lockTarget", { panelId: "agent-1" });
    expect(useVoiceRecordingStore.getState().lockedTarget?.panelId).toBe("agent-1");

    usePanelStore.setState({ focusedId: "agent-2" });
    await runAction("voiceInput.lockTarget", {});
    expect(useVoiceRecordingStore.getState().lockedTarget?.panelId).toBe("agent-2");
    expect(notify).not.toHaveBeenCalled();
  });

  it("refuses a pane with no composer, says so, and keeps the lock it had", async () => {
    dictatable.add("agent-1");
    await runAction("voiceInput.lockTarget", { panelId: "agent-1" });

    usePanelStore.setState({ focusedId: "shell-1" });
    await runAction("voiceInput.lockTarget", {});

    expect(getDictationTarget).toHaveBeenLastCalledWith("shell-1");
    expect(useVoiceRecordingStore.getState().lockedTarget?.panelId).toBe("agent-1");
    expect(useVoiceRecordingStore.getState().lastError?.code).toBe("lock_target_unavailable");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notify).mock.calls[0]![0]).toMatchObject({ title: "Dictation not locked" });
  });

  it("recalls a pane that can show the words, and refuses one that can't", async () => {
    dictatable.add("agent-1");

    await runAction("voiceInput.recallRecentTarget", { panelId: "agent-1" });
    expect(toggle).toHaveBeenCalledWith(expect.objectContaining({ panelId: "agent-1" }));

    toggle.mockClear();
    await runAction("voiceInput.recallRecentTarget", { panelId: "shell-1" });
    expect(toggle).not.toHaveBeenCalled();
    expect(useVoiceRecordingStore.getState().lastError?.code).toBe("recall_target_unavailable");
  });

  it("still stops a dictation running in a recalled pane that has lost its composer", async () => {
    stopPanelDictation.mockReturnValueOnce(Promise.resolve());

    await runAction("voiceInput.recallRecentTarget", { panelId: "shell-1" });

    expect(stopPanelDictation).toHaveBeenCalledWith("shell-1");
    expect(toggle).not.toHaveBeenCalled();
    expect(useVoiceRecordingStore.getState().lastError).toBeNull();
  });

  it("starts nothing in a recalled pane that lost its composer while the service loaded (#17031)", async () => {
    dictatable.add("agent-1");
    runtime.loaded = null;
    runtime.duringLoad = () => dictatable.delete("agent-1");

    await runAction("voiceInput.recallRecentTarget", { panelId: "agent-1" });

    expect(toggle).not.toHaveBeenCalled();
    expect(useVoiceRecordingStore.getState().lastError?.code).toBe("recall_target_unavailable");
  });

  it("finds nothing to stop in a recalled pane before the service has loaded (#17031)", async () => {
    runtime.loaded = null;

    await runAction("voiceInput.recallRecentTarget", { panelId: "shell-1" });

    expect(stopPanelDictation).not.toHaveBeenCalled();
    expect(useVoiceRecordingStore.getState().lastError?.code).toBe("recall_target_unavailable");
  });
});
