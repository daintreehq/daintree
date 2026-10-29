import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, MessageBoxOptions, WebContents } from "electron";

const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  noteTerminationIntent: vi.fn(),
}));

vi.mock("electron", () => ({ dialog: { showMessageBox: mocks.showMessageBox } }));
vi.mock("../../services/processTerminationIntent.js", () => ({
  noteTerminationIntent: mocks.noteTerminationIntent,
}));

import { attachUnresponsiveDialog } from "../unresponsiveDialog.js";

interface OpenBox {
  options: MessageBoxOptions;
  answer: (response: number) => Promise<void>;
  fail: () => Promise<void>;
}

let boxes: OpenBox[];

function fakeWindow() {
  const win = new EventEmitter() as EventEmitter & { isDestroyed: () => boolean };
  win.isDestroyed = () => false;
  return win;
}

function fakeTarget(id = 7) {
  return {
    id,
    isDestroyed: () => false,
    forcefullyCrashRenderer: vi.fn(),
  };
}

// Lets the box's `.then` / `.catch` run.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  boxes = [];
  mocks.showMessageBox.mockImplementation((_win: unknown, options: MessageBoxOptions) => {
    return new Promise((resolve, reject) => {
      const box: OpenBox = {
        options,
        answer: async (response) => {
          resolve({ response, checkboxChecked: false });
          await settle();
        },
        fail: async () => {
          reject(new Error("dialog failed"));
          await settle();
        },
      };
      // Never settled by the abort itself, so each test decides what answer
      // lands after it, as a click racing the recovery would.
      boxes.push(box);
    });
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function attach(target = fakeTarget()) {
  const win = fakeWindow();
  const dispose = attachUnresponsiveDialog(win as unknown as BrowserWindow, {
    getRestartTarget: () => target as unknown as WebContents,
  });
  return { win, target, dispose };
}

describe("attachUnresponsiveDialog (#15232)", () => {
  it("shows one box per hang, parented to the window so it can be aborted", () => {
    const { win } = attach();
    win.emit("unresponsive");
    win.emit("unresponsive");

    expect(mocks.showMessageBox).toHaveBeenCalledOnce();
    expect(mocks.showMessageBox.mock.calls[0]![0]).toBe(win);
    expect(boxes[0]!.options.signal).toBeInstanceOf(AbortSignal);
  });

  it("closes the box when the window recovers, and never acts on its answer", async () => {
    const { win, target } = attach();
    win.emit("unresponsive");
    win.emit("responsive");

    expect(boxes[0]!.options.signal!.aborted).toBe(true);
    await boxes[0]!.answer(1);
    expect(target.forcefullyCrashRenderer).not.toHaveBeenCalled();
  });

  it.each([
    ["fails", (box: OpenBox) => box.fail()],
    ["answers Wait", (box: OpenBox) => box.answer(0)],
    ["answers Restart view", (box: OpenBox) => box.answer(1)],
  ])(
    "gives the next hang a fresh box, which stays the open one when the closed box %s late",
    async (_label, settleLate) => {
      const { win, target } = attach();
      win.emit("unresponsive");
      win.emit("responsive");
      win.emit("unresponsive");

      expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
      expect(boxes[1]!.options.signal).not.toBe(boxes[0]!.options.signal);
      expect(boxes[1]!.options.signal!.aborted).toBe(false);

      await settleLate(boxes[0]!);
      expect(target.forcefullyCrashRenderer).not.toHaveBeenCalled();
      win.emit("unresponsive");
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);

      await boxes[1]!.answer(1);
      expect(target.forcefullyCrashRenderer).toHaveBeenCalledOnce();
    }
  );

  it("restarts the view on Restart view, and does nothing on Wait", async () => {
    const { win, target } = attach();
    win.emit("unresponsive");
    await boxes[0]!.answer(0);
    expect(target.forcefullyCrashRenderer).not.toHaveBeenCalled();

    win.emit("unresponsive");
    await boxes[1]!.answer(1);
    expect(mocks.noteTerminationIntent).toHaveBeenCalledWith(
      { webContentsId: target.id },
      "user force-restarted view"
    );
    expect(target.forcefullyCrashRenderer).toHaveBeenCalledOnce();
    // Attributed before the crash, so it never reads as a real one.
    expect(mocks.noteTerminationIntent.mock.invocationCallOrder[0]).toBeLessThan(
      target.forcefullyCrashRenderer.mock.invocationCallOrder[0]!
    );
  });

  it("lets a failed box be shown again on the next hang", async () => {
    const { win } = attach();
    win.emit("unresponsive");
    await boxes[0]!.fail();
    win.emit("unresponsive");
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it("detaches and closes any open box on dispose", async () => {
    const { win, target, dispose } = attach();
    win.emit("unresponsive");
    dispose();

    expect(boxes[0]!.options.signal!.aborted).toBe(true);
    expect(win.listenerCount("unresponsive")).toBe(0);
    expect(win.listenerCount("responsive")).toBe(0);
    await boxes[0]!.answer(1);
    expect(target.forcefullyCrashRenderer).not.toHaveBeenCalled();
  });
});
