// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhenClauseContext } from "@shared/utils/whenClause/types";

const voice = vi.hoisted(() => ({
  initialize: vi.fn(),
  toggleFocusedPanel: vi.fn(async (_options?: { returnToTarget?: boolean }) => {}),
  stopAndSend: vi.fn(async () => {}),
}));
const when = vi.hoisted(() => ({ context: {} as WhenClauseContext }));

vi.mock("@/services/VoiceRecordingService", () => ({ voiceRecordingService: voice }));
vi.mock("@/services/keybindingWhenContext", () => ({
  buildKeybindingWhenContext: () => when.context,
}));

import { keybindingService } from "@/services/KeybindingService";
import { startCanopyWindowDictation } from "../canopyWindowDictation";

let stop: (() => void) | null = null;
let reply: HTMLDivElement;
let terminalInput: HTMLTextAreaElement;
let reached: KeyboardEvent[];

// jsdom is not macOS, so the default table's Cmd matches as Ctrl.
function press(
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = { ctrlKey: true }
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  when.context = {};
  keybindingService.applyOverrides({});
  reached = [];
  reply = document.createElement("div");
  reply.contentEditable = "true";
  const xterm = document.createElement("div");
  xterm.className = "xterm";
  terminalInput = document.createElement("textarea");
  xterm.append(terminalInput);
  document.body.append(reply, xterm);
  for (const element of [reply, terminalInput]) {
    element.addEventListener("keydown", (event) => reached.push(event));
  }
  stop = startCanopyWindowDictation();
});

afterEach(() => {
  stop?.();
  stop = null;
  document.body.replaceChildren();
  keybindingService.applyOverrides({});
});

describe("the Canopy window's dictation keys", () => {
  it("starts the voice service, so its words and a held key's release reach this window", () => {
    expect(voice.initialize).toHaveBeenCalledTimes(1);
  });

  it("takes the dictation key from the reply and from the terminal, as the key itself", () => {
    for (const target of [reply, terminalInput]) {
      const event = press(target, "d");
      expect(event.defaultPrevented).toBe(true);
    }

    expect(voice.toggleFocusedPanel).toHaveBeenCalledTimes(2);
    expect(voice.toggleFocusedPanel).toHaveBeenLastCalledWith({ returnToTarget: true });
    expect(reached).toEqual([]);
  });

  it("follows a rebound shortcut, and leaves the old one to the reply", () => {
    keybindingService.applyOverrides({ "voiceInput.toggle": ["Cmd+Shift+M"] });

    const old = press(reply, "d");
    expect(old.defaultPrevented).toBe(false);
    expect(voice.toggleFocusedPanel).not.toHaveBeenCalled();

    press(reply, "M", { ctrlKey: true, shiftKey: true });
    expect(voice.toggleFocusedPanel).toHaveBeenCalledTimes(1);
  });

  it("stops and sends only while there is a dictation or a send to stop", () => {
    const idle = press(reply, "Enter", { ctrlKey: true, shiftKey: true });
    expect(idle.defaultPrevented).toBe(false);
    expect(reached).toEqual([idle]);
    expect(voice.stopAndSend).not.toHaveBeenCalled();

    when.context = { dictationActive: true };
    const live = press(reply, "Enter", { ctrlKey: true, shiftKey: true });
    expect(live.defaultPrevented).toBe(true);
    expect(voice.stopAndSend).toHaveBeenCalledTimes(1);
    expect(reached).toEqual([idle]);
  });

  it("leaves a held key's repeats, an IME's keys and a shortcut being recorded alone", () => {
    press(reply, "d", { ctrlKey: true, repeat: true });
    press(reply, "d", { ctrlKey: true, isComposing: true });
    const capture = vi.spyOn(keybindingService, "isCapturingShortcut").mockReturnValue(true);
    press(reply, "d");
    capture.mockRestore();

    expect(voice.toggleFocusedPanel).not.toHaveBeenCalled();
    expect(reached).toHaveLength(3);
  });

  it("answers no key once stopped", () => {
    stop?.();
    stop = null;

    const event = press(reply, "d");
    expect(event.defaultPrevented).toBe(false);
    expect(voice.toggleFocusedPanel).not.toHaveBeenCalled();
  });
});
