import { describe, expect, it, vi } from "vitest";
import type { ActionContext, ActionSource } from "@shared/types/actions";
import type { ActionRegistry } from "../../actionTypes";

const toggleFocusedPanel = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const stopAndSend = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/services/VoiceRecordingService", () => ({
  voiceRecordingService: { toggleFocusedPanel, stopAndSend },
}));

import { registerVoiceActions } from "../voiceActions";

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

    expect(stopAndSend).toHaveBeenCalledTimes(1);
    expect(toggleFocusedPanel).not.toHaveBeenCalled();
  });
});
