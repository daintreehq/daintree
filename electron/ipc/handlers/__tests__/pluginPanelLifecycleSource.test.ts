import { describe, it, expect, vi } from "vitest";
import { onWebContentsDestroyed } from "../../../window/webContentsDestroyed.js";
import { PluginPanelLifecycleBroker } from "../../../services/plugin/PluginPanelLifecycleBroker.js";
import type { ClientEndpoint } from "../../endpoint.js";
import type { IpcContext } from "../../types.js";
import { panelLifecycleSourceFor } from "../pluginPanelLifecycleSource.js";

function makeEndpoint(handle: number, kind: ClientEndpoint["kind"] = "remote-view") {
  const listeners = new Set<() => void>();
  let closed = false;
  const endpoint = {
    handle,
    kind,
    isClosed: () => closed,
    onClose: vi.fn((cb: () => void) => {
      listeners.add(cb);
      return { dispose: () => void listeners.delete(cb) };
    }),
  } as unknown as ClientEndpoint;
  return {
    endpoint,
    listenerCount: () => listeners.size,
    close: () => {
      closed = true;
      for (const cb of [...listeners]) cb();
    },
  };
}

function ctxFor(endpoint: ClientEndpoint, event: unknown = null): IpcContext {
  return { event, webContentsId: endpoint.handle, endpoint } as unknown as IpcContext;
}

const panelEvent = {
  panelId: "p1",
  panelKindId: "acme.dash",
  pluginId: "acme",
  phase: "mounted",
} as const;

describe("panelLifecycleSourceFor", () => {
  it("watches a local view through its sender", () => {
    const { endpoint } = makeEndpoint(7, "local-view");
    const sender = { id: 7 };
    expect(panelLifecycleSourceFor(ctxFor(endpoint, { sender }))).toBe(sender);
  });

  it("gives a local endpoint without an event no source", () => {
    const { endpoint } = makeEndpoint(7, "local-view");
    expect(panelLifecycleSourceFor(ctxFor(endpoint))).toBeUndefined();
  });

  it("returns one source per remote endpoint, keyed by its handle", () => {
    const { endpoint } = makeEndpoint(-3);
    const source = panelLifecycleSourceFor(ctxFor(endpoint));
    expect(source?.id).toBe(-3);
    expect(panelLifecycleSourceFor(ctxFor(endpoint))).toBe(source);
  });

  it("forgets a remote view's panels when its endpoint closes, without a removed event", () => {
    const broker = new PluginPanelLifecycleBroker((kind) =>
      kind === "acme.dash" ? "acme" : undefined
    );
    const seen: string[] = [];
    broker.subscribe("acme", (e) => seen.push(e.phase));
    const first = makeEndpoint(-1);

    broker.ingest(-1, [panelEvent]);
    onWebContentsDestroyed(panelLifecycleSourceFor(ctxFor(first.endpoint))!, () =>
      broker.clearSource(-1)
    );
    first.close();

    expect(seen).toEqual(["mounted"]);
    expect(broker.locate("p1", "acme").kind).toBe("missing");

    // The restored view reports the same panel under a new endpoint.
    broker.ingest(-2, [panelEvent]);
    expect(broker.locate("p1", "acme")).toEqual({ kind: "located", sourceId: -2 });
  });

  it("keeps a remote view's panels while its endpoint stays open", () => {
    const broker = new PluginPanelLifecycleBroker(() => "acme");
    const remote = makeEndpoint(-1);
    broker.ingest(-1, [panelEvent]);
    onWebContentsDestroyed(panelLifecycleSourceFor(ctxFor(remote.endpoint))!, () =>
      broker.clearSource(-1)
    );
    expect(broker.locate("p1", "acme").kind).toBe("located");
  });

  it("detaches its endpoint subscription when unwatched", () => {
    const remote = makeEndpoint(-4);
    const off = onWebContentsDestroyed(panelLifecycleSourceFor(ctxFor(remote.endpoint))!, () => {});
    expect(remote.listenerCount()).toBe(1);
    off();
    expect(remote.listenerCount()).toBe(0);
  });

  it("runs the callback for an endpoint that already closed", async () => {
    const remote = makeEndpoint(-5);
    remote.close();
    const cb = vi.fn();
    onWebContentsDestroyed(panelLifecycleSourceFor(ctxFor(remote.endpoint))!, cb);
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
