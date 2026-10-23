import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSurface } from "../paintFabric/__tests__/fakePaintPlane";

const m = vi.hoisted(() => ({
  failLoad: false,
  service: { setGPUHardwareAvailable: vi.fn(), focus: vi.fn() },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  get terminalInstanceService() {
    if (m.failLoad) throw new Error("chunk load failed");
    return m.service;
  },
}));

import * as accessor from "../terminalInstanceServiceAccessor";

function fakeService() {
  return makeSurface("primary").surface.plane;
}

describe("terminalInstanceServiceAccessor", () => {
  beforeEach(() => {
    accessor.__testing.reset();
    m.failLoad = false;
    m.service.setGPUHardwareAvailable.mockClear();
    m.service.focus.mockClear();
  });

  describe("peek", () => {
    it("is null before register and the instance after", () => {
      expect(accessor.peek()).toBeNull();
      const service = fakeService();
      accessor.register(service);
      expect(accessor.peek()).toBe(service);
    });

    it("keeps the first registered instance", () => {
      const first = fakeService();
      accessor.register(first);
      accessor.register(fakeService());
      expect(accessor.peek()).toBe(first);
    });
  });

  describe("load", () => {
    it("shares one load between concurrent callers and caches the result", async () => {
      const [a, b] = await Promise.all([accessor.load(), accessor.load()]);
      expect(a).toBe(m.service);
      expect(b).toBe(a);
      expect(await accessor.load()).toBe(a);
      expect(accessor.peek()).toBe(a);
    });

    it("resolves to an already registered instance without importing", async () => {
      m.failLoad = true;
      const service = fakeService();
      accessor.register(service);
      expect(await accessor.load()).toBe(service);
    });

    it("lets a later call retry after a rejected import", async () => {
      m.failLoad = true;
      await expect(accessor.load()).rejects.toThrow("chunk load failed");
      expect(accessor.peek()).toBeNull();

      m.failLoad = false;
      expect(await accessor.load()).toBe(m.service);
      expect(accessor.peek()).toBe(m.service);
    });
  });

  describe("with", () => {
    it("queues calls before load and runs them in order on load", async () => {
      const order: string[] = [];
      accessor.with(() => order.push("first"));
      accessor.with(() => order.push("second"));
      accessor.with((service) => service.focus("t1"));
      expect(order).toEqual([]);
      expect(m.service.focus).not.toHaveBeenCalled();

      await accessor.load();

      expect(order).toEqual(["first", "second"]);
      expect(m.service.focus).toHaveBeenCalledWith("t1");
    });

    it("runs queued calls on register", () => {
      const fn = vi.fn();
      accessor.with(fn);
      const service = fakeService();
      accessor.register(service);
      expect(fn).toHaveBeenCalledExactlyOnceWith(service);
    });

    it("runs immediately once the service is available", () => {
      const service = fakeService();
      accessor.register(service);
      const fn = vi.fn();
      accessor.with(fn);
      expect(fn).toHaveBeenCalledExactlyOnceWith(service);
    });

    it("keeps draining the queue when one call throws", () => {
      const after = vi.fn();
      accessor.with(() => {
        throw new Error("boom");
      });
      accessor.with(after);
      accessor.register(fakeService());
      expect(after).toHaveBeenCalledOnce();
    });
  });

  describe("onReady", () => {
    it("fires exactly once when the service becomes available", async () => {
      const cb = vi.fn();
      accessor.onReady(cb);
      expect(cb).not.toHaveBeenCalled();

      await accessor.load();
      await accessor.load();

      expect(cb).toHaveBeenCalledExactlyOnceWith(m.service);
    });

    it("fires on the next tick when the service is already available", async () => {
      const service = fakeService();
      accessor.register(service);
      const cb = vi.fn();
      accessor.onReady(cb);
      expect(cb).not.toHaveBeenCalled();

      await Promise.resolve();

      expect(cb).toHaveBeenCalledExactlyOnceWith(service);
    });

    it("skips a listener disposed by an earlier one during dispatch", () => {
      let disposeSecond = (): void => {};
      const first = vi.fn(() => disposeSecond());
      const second = vi.fn();
      accessor.onReady(first);
      disposeSecond = accessor.onReady(second);

      accessor.register(fakeService());

      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();
    });

    it("never fires after its disposer runs", async () => {
      const beforeReady = vi.fn();
      accessor.onReady(beforeReady)();
      accessor.register(fakeService());
      expect(beforeReady).not.toHaveBeenCalled();

      const afterReady = vi.fn();
      accessor.onReady(afterReady)();
      await Promise.resolve();
      expect(afterReady).not.toHaveBeenCalled();
    });
  });

  describe("__testing.reset", () => {
    it("drops a load and a ready delivery still in flight", async () => {
      accessor.register(fakeService());
      const staleReady = vi.fn();
      accessor.onReady(staleReady);
      accessor.__testing.reset();

      const staleLoad = accessor.load();
      accessor.__testing.reset();
      const queued = vi.fn();
      accessor.with(queued);

      await staleLoad;
      await Promise.resolve();

      expect(accessor.peek()).toBeNull();
      expect(queued).not.toHaveBeenCalled();
      expect(staleReady).not.toHaveBeenCalled();
    });
  });

  describe("setGpuHardwareAvailable", () => {
    it("replays the latest buffered value on load", async () => {
      accessor.setGpuHardwareAvailable(true);
      accessor.setGpuHardwareAvailable(false);
      expect(m.service.setGPUHardwareAvailable).not.toHaveBeenCalled();

      await accessor.load();

      expect(m.service.setGPUHardwareAvailable).toHaveBeenCalledExactlyOnceWith(false);
    });

    it("replays the buffered value on register", () => {
      accessor.setGpuHardwareAvailable(false);
      const service = fakeService();
      accessor.register(service);
      expect(service.setGPUHardwareAvailable).toHaveBeenCalledExactlyOnceWith(false);
    });

    it("forwards straight to a loaded service", () => {
      const service = fakeService();
      accessor.register(service);
      accessor.setGpuHardwareAvailable(true);
      expect(service.setGPUHardwareAvailable).toHaveBeenCalledExactlyOnceWith(true);
    });

    it("replays nothing when the flag was never set", async () => {
      await accessor.load();
      expect(m.service.setGPUHardwareAvailable).not.toHaveBeenCalled();
    });
  });

  describe("subscribeWhenReady", () => {
    it("attaches synchronously when the service is loaded, without a late notice", () => {
      const service = fakeService();
      accessor.register(service);
      const detach = vi.fn();
      const attach = vi.fn(() => detach);
      const late = vi.fn();

      const dispose = accessor.subscribeWhenReady(attach, late);
      expect(attach).toHaveBeenCalledExactlyOnceWith(service);
      expect(late).not.toHaveBeenCalled();

      dispose();
      expect(detach).toHaveBeenCalledOnce();
    });

    it("waits for ready without loading, then attaches before the late notice", async () => {
      const order: string[] = [];
      const attach = vi.fn(() => {
        order.push("attach");
        return () => {};
      });
      accessor.subscribeWhenReady(attach, () => order.push("late"));
      await vi.dynamicImportSettled();
      expect(attach).not.toHaveBeenCalled();
      expect(accessor.peek()).toBeNull();

      const service = fakeService();
      accessor.register(service);
      expect(attach).toHaveBeenCalledExactlyOnceWith(service);
      expect(order).toEqual(["attach", "late"]);
    });

    it("never attaches when disposed before ready", () => {
      const attach = vi.fn(() => () => {});
      const dispose = accessor.subscribeWhenReady(attach);
      dispose();
      accessor.register(fakeService());
      expect(attach).not.toHaveBeenCalled();
    });

    it("detaches a late attachment once, however often it is disposed", () => {
      const detach = vi.fn();
      const dispose = accessor.subscribeWhenReady(() => detach);
      accessor.register(fakeService());
      dispose();
      dispose();
      expect(detach).toHaveBeenCalledOnce();
    });

    it("detaches and skips the late notice when attach disposes it", () => {
      const detach = vi.fn();
      const late = vi.fn();
      let dispose = () => {};
      dispose = accessor.subscribeWhenReady(() => {
        dispose();
        return detach;
      }, late);
      accessor.register(fakeService());
      expect(detach).toHaveBeenCalledOnce();
      expect(late).not.toHaveBeenCalled();
    });

    it("detaches when disposed from inside its own late notice", () => {
      const detach = vi.fn();
      let dispose = () => {};
      dispose = accessor.subscribeWhenReady(
        () => detach,
        () => dispose()
      );
      accessor.register(fakeService());
      expect(detach).toHaveBeenCalledOnce();
    });
  });
});
