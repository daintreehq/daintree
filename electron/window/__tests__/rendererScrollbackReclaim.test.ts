import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

const sendToRendererMock = vi.hoisted(() => vi.fn());
vi.mock("../../ipc/utils.js", () => ({ sendToRenderer: sendToRendererMock }));

import { reduceHiddenRendererScrollback } from "../rendererScrollbackReclaim.js";
import { CHANNELS } from "../../ipc/channels.js";
import { SCROLLBACK_BACKGROUND } from "../../../shared/config/scrollback.js";

const win = (id: number) => ({ id }) as unknown as BrowserWindow;

describe("reduceHiddenRendererScrollback (#14215)", () => {
  beforeEach(() => {
    sendToRendererMock.mockReset();
  });

  it("sends the pressure budget to each window's active view", () => {
    const windows = [win(1), win(2)];

    reduceHiddenRendererScrollback(windows);

    expect(sendToRendererMock).toHaveBeenCalledTimes(2);
    for (const w of windows) {
      expect(sendToRendererMock).toHaveBeenCalledWith(w, CHANNELS.TERMINAL_REDUCE_SCROLLBACK, {
        targetLines: SCROLLBACK_BACKGROUND,
      });
    }
  });

  it("keeps going past a window whose send throws", () => {
    sendToRendererMock.mockImplementationOnce(() => {
      throw new Error("destroyed");
    });
    const windows = [win(1), win(2)];

    expect(() => reduceHiddenRendererScrollback(windows)).not.toThrow();
    expect(sendToRendererMock).toHaveBeenLastCalledWith(
      windows[1],
      CHANNELS.TERMINAL_REDUCE_SCROLLBACK,
      expect.anything()
    );
  });
});
