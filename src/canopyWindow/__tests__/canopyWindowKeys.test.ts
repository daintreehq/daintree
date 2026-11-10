// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhenClauseContext } from "@shared/utils/whenClause/types";

const voice = vi.hoisted(() => ({
  initialize: vi.fn(),
  toggleFocusedPanel: vi.fn(async (_options?: { returnToTarget?: boolean }) => {}),
  stopAndSend: vi.fn(async () => {}),
}));
const when = vi.hoisted(() => ({ context: {} as WhenClauseContext }));
const logError = vi.hoisted(() => vi.fn());
const focusLastProjectWindow = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/services/VoiceRecordingService", () => ({ voiceRecordingService: voice }));
vi.mock("@/services/keybindingWhenContext", () => ({
  buildKeybindingWhenContext: () => when.context,
}));
vi.mock("@/utils/logger", () => ({ logError }));

import { CLOSE_OWNER_ATTR, CLOSE_REQUEST_EVENT } from "@/lib/closeRequest";
import { keybindingService } from "@/services/KeybindingService";
import { returnToLastProjectWindow, startCanopyWindowKeys } from "../canopyWindowKeys";

let stop: (() => void) | null = null;
let reply: HTMLDivElement;
let terminalInput: HTMLTextAreaElement;
let reached: Event[];

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
  Object.defineProperty(window, "electron", {
    value: { canopyWindow: { focusLastProjectWindow } },
    configurable: true,
    writable: true,
  });
  stop = startCanopyWindowKeys();
});

afterEach(() => {
  stop?.();
  stop = null;
  document.body.replaceChildren();
  keybindingService.applyOverrides({});
  keybindingService.clearPendingChord();
});

const STOP_AND_SEND = { ctrlKey: true, shiftKey: true } as const;

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

  it("leaves the key to the reply when another binding wins it", () => {
    keybindingService.applyOverrides({ "action.palette.open": ["Cmd+D"] });

    const event = press(reply, "d");

    expect(event.defaultPrevented).toBe(false);
    expect(reached).toEqual([event]);
    expect(voice.toggleFocusedPanel).not.toHaveBeenCalled();
  });

  it("stops and sends only while there is a dictation or a send to stop", () => {
    const idle = press(reply, "Enter", STOP_AND_SEND);
    expect(idle.defaultPrevented).toBe(false);
    expect(reached).toEqual([idle]);
    expect(voice.stopAndSend).not.toHaveBeenCalled();

    when.context = { dictationActive: true };
    const live = press(reply, "Enter", STOP_AND_SEND);
    expect(live.defaultPrevented).toBe(true);

    when.context = { voiceSendWaiting: true };
    const waiting = press(reply, "Enter", STOP_AND_SEND);
    expect(waiting.defaultPrevented).toBe(true);

    expect(voice.stopAndSend).toHaveBeenCalledTimes(2);
    expect(reached).toEqual([idle]);
  });

  it("starts no chord of its own when the key it let through begins one", () => {
    keybindingService.applyOverrides({ "action.palette.open": ["Cmd+Shift+Enter Cmd+X"] });

    const idle = press(reply, "Enter", STOP_AND_SEND);

    expect(idle.defaultPrevented).toBe(false);
    expect(keybindingService.getPendingChord()).toBeNull();
  });

  it("logs a dictation key the voice service failed", async () => {
    const failure = new Error("no microphone");
    voice.toggleFocusedPanel.mockRejectedValueOnce(failure);

    press(reply, "d");
    await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));

    expect(logError.mock.calls[0]).toEqual([expect.stringContaining("voiceInput.toggle"), failure]);
  });

  it("leaves a held key's repeats, an IME's keys and a shortcut being recorded alone", () => {
    press(reply, "d", { ctrlKey: true, repeat: true });
    press(reply, "d", { ctrlKey: true, isComposing: true });
    press(reply, "d", { ctrlKey: true, keyCode: 229 });
    const capture = vi.spyOn(keybindingService, "isCapturingShortcut").mockReturnValue(true);
    press(reply, "d");
    capture.mockRestore();

    expect(voice.toggleFocusedPanel).not.toHaveBeenCalled();
    expect(reached).toHaveLength(4);
  });

  it("answers no key once stopped, and no longer reads the window for stop-and-send", () => {
    stop?.();
    stop = null;

    const event = press(reply, "d");
    expect(event.defaultPrevented).toBe(false);
    expect(voice.toggleFocusedPanel).not.toHaveBeenCalled();

    when.context = { dictationActive: true };
    const live = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", ...STOP_AND_SEND });
    expect(keybindingService.resolveKeybinding(live).match).toBeUndefined();
  });
});

describe("Canopy's own key in its window (#16578)", () => {
  beforeEach(() => {
    focusLastProjectWindow.mockReset();
    focusLastProjectWindow.mockResolvedValue(true);
  });

  it("goes back to the last project window from the reply and the list, once a press", () => {
    for (const target of [reply, document.body]) {
      const event = press(target, "e");
      expect(event.defaultPrevented).toBe(true);
    }

    expect(focusLastProjectWindow).toHaveBeenCalledTimes(2);
    expect(reached).toEqual([]);
  });

  it("leaves a key the terminal owns to the shell, as a project window does", () => {
    // Ctrl+E is readline's end-of-line: off the Mac, Cmd+E folds to it.
    const event = press(terminalInput, "e");

    expect(event.defaultPrevented).toBe(false);
    expect(reached).toEqual([event]);
    expect(focusLastProjectWindow).not.toHaveBeenCalled();
  });

  it("goes back from the terminal on a key the terminal doesn't own", () => {
    // Windows' and Linux's default, which no terminal keeps.
    keybindingService.applyOverrides({ "canopy.toggle": ["Ctrl+Shift+O"] });

    const event = press(terminalInput, "O", { ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(focusLastProjectWindow).toHaveBeenCalledTimes(1);
  });

  it("leaves a rebind without Cmd or Ctrl to the search and the terminal, taking it elsewhere", () => {
    keybindingService.applyOverrides({ "canopy.toggle": ["E"] });
    const search = document.createElement("input");
    const note = document.createElement("textarea");
    for (const field of [search, note]) {
      field.addEventListener("keydown", (event) => reached.push(event));
      document.body.append(field);
    }

    const typed = press(search, "e", {});
    const written = press(note, "e", {});
    const inTerminal = press(terminalInput, "e", {});

    expect(typed.defaultPrevented).toBe(false);
    expect(written.defaultPrevented).toBe(false);
    expect(inTerminal.defaultPrevented).toBe(false);
    expect(reached).toEqual([typed, written, inTerminal]);
    expect(focusLastProjectWindow).not.toHaveBeenCalled();

    // Out of anything typed into, as on the list, it is Canopy's key.
    const onList = press(document.body, "e", {});
    expect(onList.defaultPrevented).toBe(true);
    expect(focusLastProjectWindow).toHaveBeenCalledTimes(1);
  });

  it("follows a rebound shortcut, and leaves the old one alone", () => {
    keybindingService.applyOverrides({ "canopy.toggle": ["Cmd+Alt+K"] });

    const old = press(reply, "e");
    expect(old.defaultPrevented).toBe(false);

    press(reply, "k", { ctrlKey: true, altKey: true });
    expect(focusLastProjectWindow).toHaveBeenCalledTimes(1);
  });

  it("does nothing while Canopy is hidden, and lets the key through", () => {
    when.context = { canopyHidden: true };

    const event = press(reply, "e");

    expect(event.defaultPrevented).toBe(false);
    expect(reached).toEqual([event]);
    expect(focusLastProjectWindow).not.toHaveBeenCalled();
  });

  it("ignores a held key's repeats, an IME's keys and a shortcut being recorded", () => {
    press(reply, "e", { ctrlKey: true, repeat: true });
    press(reply, "e", { ctrlKey: true, isComposing: true });
    const capture = vi.spyOn(keybindingService, "isCapturingShortcut").mockReturnValue(true);
    press(reply, "e");
    capture.mockRestore();

    expect(focusLastProjectWindow).not.toHaveBeenCalled();
  });

  it("closes nothing and logs nothing when no project window is open", async () => {
    focusLastProjectWindow.mockResolvedValue(false);

    press(reply, "e");
    await vi.waitFor(() => expect(focusLastProjectWindow).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(logError).not.toHaveBeenCalled();
  });

  it("logs a refusal from main", async () => {
    const failure = new Error("refused");
    focusLastProjectWindow.mockRejectedValue(failure);

    returnToLastProjectWindow();
    await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));

    expect(logError.mock.calls[0]![1]).toBe(failure);
  });

  it("answers no key once stopped", () => {
    stop?.();
    stop = null;

    const event = press(reply, "e");

    expect(event.defaultPrevented).toBe(false);
    expect(focusLastProjectWindow).not.toHaveBeenCalled();
  });
});

describe("Cmd+W in the Canopy window (#16618)", () => {
  let closeWindow: ReturnType<typeof vi.fn>;
  let pane: HTMLElement;
  let paneReply: HTMLDivElement;
  let paneHeader: HTMLButtonElement;
  let paneTerminal: HTMLTextAreaElement;
  let search: HTMLInputElement;
  let trashed: number;

  beforeEach(() => {
    closeWindow = vi.fn(async () => {});
    Object.defineProperty(window, "electron", {
      value: { canopyWindow: { focusLastProjectWindow }, window: { close: closeWindow } },
      configurable: true,
      writable: true,
    });
    trashed = 0;
    pane = document.createElement("section");
    pane.setAttribute(CLOSE_OWNER_ATTR, "");
    pane.addEventListener(CLOSE_REQUEST_EVENT, (event) => {
      event.preventDefault();
      trashed += 1;
    });
    paneHeader = document.createElement("button");
    paneReply = document.createElement("div");
    paneReply.contentEditable = "true";
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    paneTerminal = document.createElement("textarea");
    xterm.append(paneTerminal);
    pane.append(paneHeader, paneReply, xterm);
    search = document.createElement("input");
    document.body.append(search, pane);
    for (const element of [paneReply, paneHeader, paneTerminal, search]) {
      element.addEventListener("keydown", (event) => reached.push(event));
    }
  });

  it("trashes the agent's terminal from its reply and its title bar, and keeps the window", () => {
    for (const target of [paneReply, paneHeader]) {
      const event = press(target, "w");
      expect(event.defaultPrevented).toBe(true);
    }

    expect(trashed).toBe(2);
    expect(closeWindow).not.toHaveBeenCalled();
    expect(reached).toEqual([]);
  });

  it("closes the window from the list and the search, with no pane in hand", () => {
    for (const target of [document.body, search]) {
      const event = press(target, "w");
      expect(event.defaultPrevented).toBe(true);
    }

    expect(closeWindow).toHaveBeenCalledTimes(2);
    expect(trashed).toBe(0);
  });

  it("leaves Ctrl+W in the terminal to the shell off the Mac, closing nothing", () => {
    const event = press(paneTerminal, "w");

    expect(event.defaultPrevented).toBe(false);
    expect(reached).toEqual([event]);
    expect(trashed).toBe(0);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("trashes on a rebound close, the terminal included, and never closes the window from a pane", () => {
    keybindingService.applyOverrides({ "terminal.close": ["Cmd+Shift+W"] });

    const rebound = press(paneTerminal, "W", { ctrlKey: true, shiftKey: true });
    expect(rebound.defaultPrevented).toBe(true);
    expect(trashed).toBe(1);
    expect(closeWindow).not.toHaveBeenCalled();

    // Out of a pane the rebound key has nothing to close, and goes on.
    const onList = press(search, "W", { ctrlKey: true, shiftKey: true });
    expect(onList.defaultPrevented).toBe(false);

    // Close Window's own key is no longer the pane's, and the window stays.
    const old = press(paneReply, "w");
    expect(old.defaultPrevented).toBe(false);
    expect(closeWindow).not.toHaveBeenCalled();
    expect(trashed).toBe(1);

    // From the list it still closes the window, whatever the binding.
    press(document.body, "w");
    expect(closeWindow).toHaveBeenCalledTimes(1);
  });

  it("keeps a chord-bound close out of the pane, and the window open there", () => {
    keybindingService.applyOverrides({ "terminal.close": ["Cmd+K Cmd+W"] });

    const first = press(paneReply, "k");
    const second = press(paneReply, "w");

    expect(first.defaultPrevented).toBe(false);
    expect(second.defaultPrevented).toBe(false);
    expect(keybindingService.getPendingChord()).toBeNull();
    expect(trashed).toBe(0);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("leaves Cmd+W to a chord it begins, closing nothing and starting no chord", () => {
    keybindingService.applyOverrides({
      "terminal.close": ["Cmd+Shift+W"],
      "action.palette.open": ["Cmd+W Cmd+X"],
    });

    const event = press(document.body, "w");

    expect(event.defaultPrevented).toBe(false);
    expect(keybindingService.getPendingChord()).toBeNull();
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("keeps the window open when the pane doesn't take the close", () => {
    const loose = document.createElement("section");
    loose.setAttribute(CLOSE_OWNER_ATTR, "");
    const field = document.createElement("input");
    loose.append(field);
    document.body.append(loose);

    const event = press(field, "w");

    expect(event.defaultPrevented).toBe(false);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("leaves Cmd+W to another binding that outranks the close, closing nothing", () => {
    // The portal's close-tab binding holds Cmd+W at a higher priority in its scope.
    keybindingService.setScope("portal");
    try {
      const inPane = press(paneReply, "w");
      const onList = press(document.body, "w");

      expect(inPane.defaultPrevented).toBe(false);
      expect(onList.defaultPrevented).toBe(false);
      expect(reached).toEqual([inPane]);
      expect(trashed).toBe(0);
      expect(closeWindow).not.toHaveBeenCalled();
    } finally {
      keybindingService.restoreScope("portal");
    }
  });

  it("leaves Cmd+W to another binding that wins it from the list", () => {
    keybindingService.applyOverrides({
      "action.palette.open": ["Cmd+W"],
      "terminal.close": ["Cmd+Shift+W"],
    });

    const onList = press(document.body, "w");

    expect(onList.defaultPrevented).toBe(false);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("closes nothing on Cmd+Shift+W, which Close Window doesn't answer", () => {
    keybindingService.applyOverrides({ "terminal.watch": [] });

    const event = press(document.body, "W", { ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("leaves a close bound without Cmd or Ctrl to what is typed into, taking it on the title bar", () => {
    keybindingService.applyOverrides({ "terminal.close": ["Q"] });
    const rename = document.createElement("input");
    const note = document.createElement("textarea");
    // jsdom has no isContentEditable of its own.
    Object.defineProperty(paneReply, "isContentEditable", { value: true });
    pane.append(rename, note);

    for (const target of [paneTerminal, rename, note, paneReply]) {
      const typed = press(target, "q", {});
      expect(typed.defaultPrevented).toBe(false);
    }
    expect(trashed).toBe(0);

    const onHeader = press(paneHeader, "q", {});
    expect(onHeader.defaultPrevented).toBe(true);
    expect(trashed).toBe(1);
  });

  it("takes Canopy's own key first when the user binds it to Cmd+W", () => {
    keybindingService.applyOverrides({
      "canopy.toggle": ["Cmd+W"],
      "terminal.close": ["Cmd+Shift+W"],
    });

    press(document.body, "w");

    expect(focusLastProjectWindow).toHaveBeenCalledTimes(1);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("ignores a held Cmd+W's repeats and a shortcut being recorded", () => {
    press(paneReply, "w", { ctrlKey: true, repeat: true });
    press(document.body, "w", { ctrlKey: true, repeat: true });
    const capture = vi.spyOn(keybindingService, "isCapturingShortcut").mockReturnValue(true);
    press(document.body, "w");
    capture.mockRestore();

    expect(trashed).toBe(0);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("logs a close main refused", async () => {
    const failure = new Error("refused");
    closeWindow.mockRejectedValueOnce(failure);

    press(document.body, "w");
    await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));

    expect(logError.mock.calls[0]![1]).toBe(failure);
  });

  describe("on the Mac", () => {
    let platform: { mockRestore: () => void };
    beforeEach(() => {
      platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    });
    afterEach(() => {
      platform.mockRestore();
    });

    it("trashes from the terminal on Cmd+W, which no shell keeps, and closes from the list", () => {
      for (const target of [paneTerminal, paneReply, paneHeader]) {
        const event = press(target, "w", { metaKey: true });
        expect(event.defaultPrevented).toBe(true);
      }
      expect(trashed).toBe(3);
      expect(closeWindow).not.toHaveBeenCalled();

      press(search, "w", { metaKey: true });
      expect(closeWindow).toHaveBeenCalledTimes(1);
      expect(trashed).toBe(3);
    });

    it("leaves a close bound to Ctrl+W to the shell in the terminal, trashing from the reply", () => {
      keybindingService.applyOverrides({ "terminal.close": ["Ctrl+W"] });

      const inTerminal = press(paneTerminal, "w", { ctrlKey: true });
      expect(inTerminal.defaultPrevented).toBe(false);
      expect(trashed).toBe(0);

      const inReply = press(paneReply, "w", { ctrlKey: true });
      expect(inReply.defaultPrevented).toBe(true);
      expect(trashed).toBe(1);
      expect(closeWindow).not.toHaveBeenCalled();
    });
  });

  it("answers no Cmd+W once stopped", () => {
    stop?.();
    stop = null;

    const inPane = press(paneReply, "w");
    const onList = press(document.body, "w");

    expect(inPane.defaultPrevented).toBe(false);
    expect(onList.defaultPrevented).toBe(false);
    expect(trashed).toBe(0);
    expect(closeWindow).not.toHaveBeenCalled();
  });
});
