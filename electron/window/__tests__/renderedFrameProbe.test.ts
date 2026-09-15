import { describe, it, expect, vi } from "vitest";
import { waitForRenderedFrame } from "../renderedFrameProbe.js";

function makeWc(opts: { destroyed?: boolean; execute?: () => Promise<unknown> } = {}) {
  return {
    isDestroyed: vi.fn(() => opts.destroyed ?? false),
    executeJavaScript: vi.fn(opts.execute ?? (() => Promise.resolve(true))),
  };
}

describe("waitForRenderedFrame (#12394)", () => {
  it("asks the page to wait out two animation frames", async () => {
    const wc = makeWc();
    await expect(waitForRenderedFrame(wc as never)).resolves.toBe(true);
    expect(wc.executeJavaScript).toHaveBeenCalledOnce();
    const script = wc.executeJavaScript.mock.calls[0]?.[0] as string;
    // Double rAF: the second callback runs only after the first frame committed.
    expect(script.match(/requestAnimationFrame/g)).toHaveLength(2);
  });

  it("stays pending until the page's frames run", async () => {
    let finishFrames: () => void = () => {};
    const wc = makeWc({
      execute: () => new Promise((resolve) => (finishFrames = () => resolve(true))),
    });
    let settled = false;
    const probe = waitForRenderedFrame(wc as never).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishFrames();
    await probe;
    expect(settled).toBe(true);
  });

  it("treats any resolved value as a confirmed frame", async () => {
    const wc = makeWc({ execute: () => Promise.resolve(undefined) });
    await expect(waitForRenderedFrame(wc as never)).resolves.toBe(true);
  });

  it("resolves false without evaluating for a destroyed view", async () => {
    const wc = makeWc({ destroyed: true });
    await expect(waitForRenderedFrame(wc as never)).resolves.toBe(false);
    expect(wc.executeJavaScript).not.toHaveBeenCalled();
  });

  it("resolves false when the evaluation rejects or throws", async () => {
    const rejecting = makeWc({ execute: () => Promise.reject(new Error("navigated")) });
    await expect(waitForRenderedFrame(rejecting as never)).resolves.toBe(false);

    const throwing = makeWc({
      execute: () => {
        throw new Error("Object has been destroyed");
      },
    });
    await expect(waitForRenderedFrame(throwing as never)).resolves.toBe(false);
  });
});
