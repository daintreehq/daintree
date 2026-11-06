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
vi.mock("@/services/VoiceRecordingService", () => ({
  voiceRecordingService: {
    toggleFocusedPanel,
    stopAndSend,
    toggle,
    getDictationTarget,
    stopPanelDictation,
  },
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
});
