import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { thawThenSend } from "../thawThenSend.js";
import { freezeWebContents, isWebContentsFrozen } from "../webContentsLifecycle.js";

interface MockWebContents {
  isDestroyed: ReturnType<typeof vi.fn>;
  debugger: {
    isAttached: ReturnType<typeof vi.fn>;
    attach: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
  };
}

function createMockWc(): MockWebContents {
  let attached = false;
  return {
    isDestroyed: vi.fn(() => false),
    debugger: {
      isAttached: vi.fn(() => attached),
      attach: vi.fn(() => {
        attached = true;
      }),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    },
  };
}

const asWc = (wc: MockWebContents) => wc as unknown as Electron.WebContents;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function frozenWc(): Promise<MockWebContents> {
  const wc = createMockWc();
  await freezeWebContents(asWc(wc));
  expect(isWebContentsFrozen(asWc(wc))).toBe(true);
  wc.debugger.attach.mockClear();
  wc.debugger.sendCommand.mockClear();
  return wc;
}

describe("thawThenSend", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe("a view main never froze (#17036)", () => {
    it("sends at once, with no debugger attach and no CDP command", () => {
      const wc = createMockWc();
      const send = vi.fn();

      thawThenSend(asWc(wc), () => true, send);

      expect(send).toHaveBeenCalledTimes(1);
      expect(wc.debugger.attach).not.toHaveBeenCalled();
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });

    it("sends nothing for a request already settled", () => {
      const wc = createMockWc();
      const send = vi.fn();

      thawThenSend(asWc(wc), () => false, send);

      expect(send).not.toHaveBeenCalled();
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });

    it("sends nothing to a destroyed view", () => {
      const wc = createMockWc();
      wc.isDestroyed.mockReturnValue(true);
      const send = vi.fn();

      thawThenSend(asWc(wc), () => true, send);

      expect(send).not.toHaveBeenCalled();
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });

    it("sends at once to a view whose freeze was thawed since", async () => {
      const wc = await frozenWc();
      thawThenSend(asWc(wc), () => true, vi.fn());
      await flush();
      expect(isWebContentsFrozen(asWc(wc))).toBe(false);
      wc.debugger.sendCommand.mockClear();

      const send = vi.fn();
      thawThenSend(asWc(wc), () => true, send);

      expect(send).toHaveBeenCalledTimes(1);
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });
  });

  describe("a frozen view", () => {
    it("thaws before it sends", async () => {
      const wc = await frozenWc();
      const order: string[] = [];
      wc.debugger.sendCommand.mockImplementation(async (method: string, params?: unknown) => {
        order.push(params ? `${method}:${JSON.stringify(params)}` : method);
      });
      const send = vi.fn(() => order.push("send"));

      thawThenSend(asWc(wc), () => true, send);
      expect(send).not.toHaveBeenCalled();
      await flush();

      expect(order).toEqual([
        "Page.enable",
        'Page.setWebLifecycleState:{"state":"active"}',
        "send",
      ]);
      expect(isWebContentsFrozen(asWc(wc))).toBe(false);
    });

    it("thaws a view whose freeze is still in flight, and sends once it is thawed", async () => {
      const wc = createMockWc();
      // One debugger session answers in the order it was asked, so the thaw's
      // commands queue behind the freeze's, and the first answer is held.
      let releaseFirst!: () => void;
      const firstAnswer = new Promise<void>((resolve) => (releaseFirst = resolve));
      let answered: Promise<void> = Promise.resolve();
      let asked = 0;
      const order: string[] = [];
      wc.debugger.sendCommand.mockImplementation((method: string, params?: unknown) => {
        if (method === "Page.setWebLifecycleState") {
          order.push((params as { state: string }).state);
        }
        const gate = asked++ === 0 ? firstAnswer : Promise.resolve();
        answered = answered.then(() => gate);
        return answered;
      });
      const freezing = freezeWebContents(asWc(wc));
      expect(isWebContentsFrozen(asWc(wc))).toBe(true);
      let frozenAtSend: boolean | undefined;
      const send = vi.fn(() => {
        frozenAtSend = isWebContentsFrozen(asWc(wc));
        order.push("send");
      });

      thawThenSend(asWc(wc), () => true, send);
      expect(send).not.toHaveBeenCalled();
      releaseFirst();
      await freezing;
      await flush();

      expect(order).toEqual(["frozen", "active", "send"]);
      expect(frozenAtSend).toBe(false);
    });

    it("skips the send when the request settled during the thaw", async () => {
      const wc = await frozenWc();
      let pending = true;
      const send = vi.fn();

      thawThenSend(asWc(wc), () => pending, send);
      pending = false;
      await flush();

      expect(wc.debugger.sendCommand).toHaveBeenCalledWith("Page.setWebLifecycleState", {
        state: "active",
      });
      expect(send).not.toHaveBeenCalled();
    });

    it("skips the send when the view is destroyed during the thaw", async () => {
      const wc = await frozenWc();
      const send = vi.fn();

      thawThenSend(asWc(wc), () => true, send);
      wc.isDestroyed.mockReturnValue(true);
      await flush();

      expect(send).not.toHaveBeenCalled();
    });

    it("still sends when the thaw fails", async () => {
      const wc = await frozenWc();
      wc.debugger.sendCommand.mockRejectedValue(new Error("Target closed"));
      const send = vi.fn();

      thawThenSend(asWc(wc), () => true, send);
      await flush();

      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
