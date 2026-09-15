import { describe, it, expect, vi } from "vitest";
import vm from "node:vm";
import { HIDDEN_DOCUMENT_SETTLE_MS, waitForRenderedFrame } from "../renderedFrameProbe.js";

function createPage(initial: "visible" | "hidden") {
  const listeners = new Set<() => void>();
  const document = {
    visibilityState: initial as string,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  return {
    document,
    listenerCount: () => listeners.size,
    setVisibility(state: "visible" | "hidden") {
      document.visibilityState = state;
      listeners.forEach((listener) => listener());
    },
  };
}

function makeWin(opts: { minimized?: boolean; visible?: boolean } = {}) {
  const handlers = new Map<string, Array<() => void>>();
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => opts.minimized ?? false),
    isVisible: vi.fn(() => opts.visible ?? true),
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    removeListener: vi.fn((event: string, handler: () => void) => {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((h) => h !== handler)
      );
    }),
    emit: (event: string) => (handlers.get(event) ?? []).forEach((h) => h()),
    listenerCount: () => [...handlers.values()].reduce((n, list) => n + list.length, 0),
  };
}

function makeWc(opts: { destroyed?: boolean; execute?: () => Promise<unknown> } = {}) {
  const execute = opts.execute ?? (() => Promise.resolve(true));
  return {
    isDestroyed: vi.fn(() => opts.destroyed ?? false),
    executeJavaScript: vi.fn((_code: string): Promise<unknown> => execute()),
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

  it("evaluates to a promise that resolves only after the second nested frame", async () => {
    const wc = makeWc();
    await waitForRenderedFrame(wc as never);
    const script = wc.executeJavaScript.mock.calls[0]?.[0] as string;

    const frameCallbacks: Array<() => void> = [];
    const requestAnimationFrame = (callback: () => void) => frameCallbacks.push(callback);
    const page = createPage("visible");
    let settled = false;
    const result = Promise.resolve(
      vm.runInNewContext(script, {
        requestAnimationFrame,
        document: page.document,
        setTimeout,
        clearTimeout,
      }) as Promise<unknown>
    ).then((value) => {
      settled = true;
      return value;
    });

    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    // One frame is not enough: the second is requested from inside the first.
    expect(settled).toBe(false);
    expect(frameCallbacks).toHaveLength(1);

    frameCallbacks.shift()?.();
    await expect(result).resolves.toBe(true);
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

  it("confirms without evaluating when the window is minimised or hidden", async () => {
    const minimised = makeWc();
    await expect(
      waitForRenderedFrame(minimised as never, makeWin({ minimized: true }) as never)
    ).resolves.toBe(true);
    expect(minimised.executeJavaScript).not.toHaveBeenCalled();

    const hidden = makeWc();
    await expect(
      waitForRenderedFrame(hidden as never, makeWin({ visible: false }) as never)
    ).resolves.toBe(true);
    expect(hidden.executeJavaScript).not.toHaveBeenCalled();
  });

  it("confirms a pending probe when its window is minimised or hidden mid-wait", async () => {
    for (const event of ["minimize", "hide"]) {
      const wc = makeWc({ execute: () => new Promise(() => {}) });
      const win = makeWin();
      const probe = waitForRenderedFrame(wc as never, win as never);
      await Promise.resolve();
      win.emit(event);
      await expect(probe).resolves.toBe(true);
      expect(win.listenerCount()).toBe(0);
    }
  });

  it("still waits for frames in a visible window", async () => {
    let finishFrames: () => void = () => {};
    const wc = makeWc({
      execute: () => new Promise((resolve) => (finishFrames = () => resolve(true))),
    });
    const win = makeWin();
    let settled = false;
    const probe = waitForRenderedFrame(wc as never, win as never).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishFrames();
    await probe;
    expect(win.listenerCount()).toBe(0);
  });

  describe("hidden document in the page", () => {
    async function runProbe(initial: "visible" | "hidden") {
      const wc = makeWc();
      await waitForRenderedFrame(wc as never);
      const script = wc.executeJavaScript.mock.calls[0]?.[0] as string;
      const page = createPage(initial);
      const frameCallbacks: Array<() => void> = [];
      let settled = false;
      const result = Promise.resolve(
        vm.runInNewContext(script, {
          requestAnimationFrame: (callback: () => void) => frameCallbacks.push(callback),
          document: page.document,
          setTimeout,
          clearTimeout,
        }) as Promise<unknown>
      ).then(() => {
        settled = true;
      });
      return { page, frameCallbacks, isSettled: () => settled, result };
    }

    it("confirms a document that stays hidden past the settle (an occluded window)", async () => {
      vi.useFakeTimers();
      try {
        const probe = await runProbe("hidden");
        await vi.advanceTimersByTimeAsync(HIDDEN_DOCUMENT_SETTLE_MS - 1);
        expect(probe.isSettled()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await probe.result;
        expect(probe.page.listenerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("confirms a document that goes hidden mid-wait once the settle passes", async () => {
      vi.useFakeTimers();
      try {
        const probe = await runProbe("visible");
        probe.page.setVisibility("hidden");
        await vi.advanceTimersByTimeAsync(HIDDEN_DOCUMENT_SETTLE_MS);
        await probe.result;
        expect(probe.isSettled()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not confirm on a hidden state that turns visible before the settle", async () => {
      vi.useFakeTimers();
      try {
        // A just-shown view whose visibility update has not reached its renderer.
        const probe = await runProbe("hidden");
        await vi.advanceTimersByTimeAsync(10);
        probe.page.setVisibility("visible");
        await vi.advanceTimersByTimeAsync(HIDDEN_DOCUMENT_SETTLE_MS * 4);
        expect(probe.isSettled()).toBe(false);

        probe.frameCallbacks.shift()?.();
        probe.frameCallbacks.shift()?.();
        await probe.result;
        expect(probe.page.listenerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
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
