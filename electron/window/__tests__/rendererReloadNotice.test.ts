import { EventEmitter } from "node:events";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { WebContents } from "electron";
import { CHANNELS } from "../../ipc/channels.js";
import {
  holdReloadNotice,
  releaseReloadNotice,
  rendererReloadNotice,
  resetReloadNoticesForTest,
} from "../rendererReloadNotice.js";

describe("rendererReloadNotice", () => {
  it("says a killed renderer was stopped from outside, not that it crashed", () => {
    const text = rendererReloadNotice("A project view", "killed");
    expect(text).toBe("A project view was stopped from outside Daintree and was reloaded.");
    expect(text).not.toContain("crashed");
  });

  it("doesn't blame an outside process when Daintree restarted the view itself", () => {
    const text = rendererReloadNotice("A project view", "killed", "user force-restarted view");
    expect(text).not.toContain("outside");
    expect(text).not.toContain("crashed");
  });

  it("keeps crash wording for real crashes", () => {
    expect(rendererReloadNotice("The renderer process", "crashed")).toBe(
      "The renderer process crashed and was automatically reloaded."
    );
  });
});

function fakeWebContents(id: number) {
  const emitter = new EventEmitter();
  let destroyed = false;
  const wc = Object.assign(emitter, {
    id,
    send: vi.fn(),
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true;
      emitter.emit("destroyed");
    },
  });
  return wc as typeof wc & WebContents;
}

describe("held reload notices", () => {
  afterEach(() => resetReloadNoticesForTest());

  it("sends nothing until the reloaded view reports first-interactive, then sends once", () => {
    const wc = fakeWebContents(7);
    holdReloadNotice(wc, "A project view crashed and was automatically reloaded.");
    expect(wc.send).not.toHaveBeenCalled();

    releaseReloadNotice(wc);
    releaseReloadNotice(wc);

    expect(wc.send).toHaveBeenCalledTimes(1);
    expect(wc.send).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "warning",
      message: "A project view crashed and was automatically reloaded.",
      urgent: true,
    });
    expect(wc.listenerCount("destroyed")).toBe(0);
  });

  it("keeps one notice per view, the latest", () => {
    const wc = fakeWebContents(7);
    holdReloadNotice(wc, "first");
    holdReloadNotice(wc, "A project view was restarted.", "info");

    releaseReloadNotice(wc);

    expect(wc.send).toHaveBeenCalledTimes(1);
    expect(wc.send).toHaveBeenCalledWith(
      CHANNELS.NOTIFICATION_SHOW_TOAST,
      expect.objectContaining({ type: "info", message: "A project view was restarted." })
    );
    expect(wc.listenerCount("destroyed")).toBe(0);
  });

  it("is not drained by another view's first-interactive", () => {
    const crashed = fakeWebContents(7);
    const other = fakeWebContents(8);
    holdReloadNotice(crashed, "reloaded");

    releaseReloadNotice(other);
    expect(other.send).not.toHaveBeenCalled();

    releaseReloadNotice(crashed);
    expect(crashed.send).toHaveBeenCalledTimes(1);
  });

  it("drops the notice when the view is destroyed before it reloads", () => {
    const wc = fakeWebContents(7);
    holdReloadNotice(wc, "reloaded");
    wc.destroy();

    releaseReloadNotice(wc);

    expect(wc.send).not.toHaveBeenCalled();
  });

  it("keeps the notice for the next report when the send throws", () => {
    const wc = fakeWebContents(7);
    holdReloadNotice(wc, "reloaded");
    wc.send.mockImplementationOnce(() => {
      throw new Error("Render frame was disposed");
    });

    releaseReloadNotice(wc);
    releaseReloadNotice(wc);

    expect(wc.send).toHaveBeenCalledTimes(2);
    expect(wc.listenerCount("destroyed")).toBe(0);
  });
});
