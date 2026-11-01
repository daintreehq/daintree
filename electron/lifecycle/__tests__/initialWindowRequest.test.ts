import { describe, expect, it, vi } from "vitest";
import { createInitialWindowRequest } from "../initialWindowRequest.js";

function setup() {
  let finish: () => void = () => {};
  let fail: (error: Error) => void = () => {};
  const openLaunchWindows = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      })
  );
  const createWindow = vi.fn(async () => {});
  let shuttingDown = false;
  const request = createInitialWindowRequest({
    openLaunchWindows,
    createWindow,
    isShuttingDown: () => shuttingDown,
  });
  return {
    request,
    openLaunchWindows,
    createWindow,
    finish: () => finish(),
    fail: (error: Error) => fail(error),
    quit: () => {
      shuttingDown = true;
    },
  };
}

describe("createInitialWindowRequest", () => {
  it("opens the launch's windows once, joining requests that arrive while they open", async () => {
    const { request, openLaunchWindows, createWindow, finish } = setup();

    const first = request.open();
    const second = request.open();
    await Promise.resolve();
    expect(openLaunchWindows).toHaveBeenCalledOnce();

    finish();
    await Promise.all([first, second]);
    expect(createWindow).not.toHaveBeenCalled();
    expect(openLaunchWindows).toHaveBeenCalledWith({ targeted: false, opensFolder: false });
  });

  it("opens a plain window for every request after the first", async () => {
    const { request, openLaunchWindows, createWindow, finish } = setup();

    const first = request.open();
    await Promise.resolve();
    finish();
    await first;
    await request.open();
    await request.open();

    expect(openLaunchWindows).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledTimes(2);
  });

  it("never restores the launch's windows again after a failed attempt", async () => {
    const { request, openLaunchWindows, createWindow, fail } = setup();

    const first = request.open();
    await Promise.resolve();
    fail(new Error("restore failed"));
    await expect(first).rejects.toThrow("restore failed");
    await request.open();

    expect(openLaunchWindows).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledOnce();
  });

  it("lets the first request say whether the launch was targeted", async () => {
    const { request, openLaunchWindows, finish } = setup();

    const first = request.open({ targeted: true, opensFolder: true });
    const joined = request.open({ targeted: false, opensFolder: false });
    await Promise.resolve();
    finish();
    await Promise.all([first, joined]);

    expect(openLaunchWindows).toHaveBeenCalledExactlyOnceWith({
      targeted: true,
      opensFolder: true,
    });
  });

  it("opens nothing once Daintree is quitting", async () => {
    const { request, openLaunchWindows, createWindow, quit } = setup();

    quit();
    await request.open();

    expect(openLaunchWindows).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
  });
});
