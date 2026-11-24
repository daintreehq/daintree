import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginHostedViewConsumers } from "../../../services/plugin/PluginHostedViewConsumers.js";

const service = vi.hoisted(() => ({
  consumers: null as PluginHostedViewConsumers | null,
  ingestHostedViewConsumers: vi.fn(),
  ingestPanelLifecycleEvents: vi.fn(),
}));
vi.mock("../plugin/service.js", () => ({ getPluginService: vi.fn(async () => service) }));

import type { ClientEndpoint } from "../../endpoint.js";
import type { IpcContext } from "../../types.js";
import { getPluginService } from "../plugin/service.js";
import { handleReportPanelLifecycle, handleReportViewConsumers } from "../plugin/runtime.js";

let nextId = 1;

class FakeContents extends EventEmitter {
  id = nextId++;
  destroyed = false;
  isDestroyed() {
    return this.destroyed;
  }
}

function localCtx(wc: FakeContents): IpcContext {
  return {
    event: { sender: wc },
    webContentsId: wc.id,
    projectId: null,
    endpoint: { handle: wc.id, kind: "local-view" },
  } as unknown as IpcContext;
}

function remoteCtx(handle: number) {
  const listeners = new Set<() => void>();
  const endpoint = {
    handle,
    kind: "remote-view",
    isClosed: () => false,
    onClose: (cb: () => void) => {
      listeners.add(cb);
      return { dispose: () => void listeners.delete(cb) };
    },
  } as unknown as ClientEndpoint;
  const ctx = { event: null, webContentsId: handle, projectId: null, endpoint } as IpcContext;
  return { ctx, close: () => [...listeners].forEach((cb) => cb()) };
}

const owner = (viewId: string) => (viewId.startsWith("plugin-view:acme/") ? "acme" : undefined);
const count = () => service.consumers!.count("acme", owner);

beforeEach(() => {
  service.ingestPanelLifecycleEvents.mockReset();
  service.consumers = new PluginHostedViewConsumers(() => {});
  service.ingestHostedViewConsumers.mockReset().mockImplementation((sourceId, watch, viewIds) => {
    service.consumers!.record(sourceId, watch, viewIds);
  });
});

describe("plugin view consumer handler (#17068)", () => {
  it("forgets a local view's mounts when its document navigates away", async () => {
    const wc = new FakeContents();
    await handleReportViewConsumers(localCtx(wc), ["plugin-view:acme/side"]);
    expect(service.ingestHostedViewConsumers).toHaveBeenCalledWith(wc.id, expect.any(Function), [
      "plugin-view:acme/side",
    ]);
    expect(count()).toBe(1);

    wc.emit("did-navigate");
    expect(count()).toBe(0);
  });

  it("forgets a local view's mounts when its renderer crashes", async () => {
    const wc = new FakeContents();
    await handleReportViewConsumers(localCtx(wc), ["plugin-view:acme/side"]);
    wc.emit("render-process-gone");
    expect(count()).toBe(0);
  });

  it("drops a report from a view already destroyed, which nothing would ever forget", async () => {
    const wc = new FakeContents();
    wc.destroyed = true;
    await handleReportViewConsumers(localCtx(wc), ["plugin-view:acme/side"]);
    expect(service.ingestHostedViewConsumers).not.toHaveBeenCalled();
  });

  it.each(["destroyed", "did-navigate", "render-process-gone"])(
    "drops a report whose document ended (%s) while the service was still loading",
    async (ending) => {
      let resolveService: (value: typeof service) => void = () => {};
      vi.mocked(getPluginService).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveService = resolve;
          }) as unknown as ReturnType<typeof getPluginService>
      );
      const wc = new FakeContents();
      const pending = handleReportViewConsumers(localCtx(wc), ["plugin-view:acme/side"]);
      if (ending === "destroyed") wc.destroyed = true;
      wc.emit(ending);
      resolveService(service);
      await pending;
      expect(service.ingestHostedViewConsumers).not.toHaveBeenCalled();
      // The watch that observed the gap is gone with it.
      expect(wc.listenerCount("did-navigate")).toBe(0);
    }
  );

  it("detaches its watch when the service fails to load", async () => {
    vi.mocked(getPluginService).mockRejectedValueOnce(new Error("load failed"));
    const wc = new FakeContents();
    await expect(
      handleReportViewConsumers(localCtx(wc), ["plugin-view:acme/side"])
    ).rejects.toThrow("load failed");
    expect(wc.eventNames()).toEqual([]);
  });

  it("still records a report when nothing ended while the service loaded", async () => {
    let resolveService: (value: typeof service) => void = () => {};
    vi.mocked(getPluginService).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveService = resolve;
        }) as unknown as ReturnType<typeof getPluginService>
    );
    const wc = new FakeContents();
    const pending = handleReportViewConsumers(localCtx(wc), ["plugin-view:acme/side"]);
    resolveService(service);
    await pending;
    expect(count()).toBe(1);
    // Only the report's own watch is left.
    expect(wc.listenerCount("did-navigate")).toBe(1);
  });

  it("passes a panel lifecycle replay through as one, and a plain batch as transitions", async () => {
    const wc = new FakeContents();
    const events = [{ panelId: "p1", panelKindId: "acme.dash", pluginId: "acme", phase: "hidden" }];
    await handleReportPanelLifecycle(localCtx(wc), events as never, { replay: true });
    await handleReportPanelLifecycle(localCtx(wc), events as never);
    expect(service.ingestPanelLifecycleEvents.mock.calls.map((call) => call[3])).toEqual([
      { replay: true },
      { replay: false },
    ]);
  });

  it("forgets a remote view's mounts when its endpoint closes", async () => {
    const remote = remoteCtx(900);
    await handleReportViewConsumers(remote.ctx, ["plugin-view:acme/side"]);
    expect(count()).toBe(1);

    remote.close();
    expect(count()).toBe(0);
  });
});
