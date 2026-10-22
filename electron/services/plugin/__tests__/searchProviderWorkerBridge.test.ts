/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { PluginDevWorkerMainBridge } from "../PluginDevWorkerMainBridge.js";
import { PluginDevWorkerHostProxy } from "../pluginDevWorkerHostProxy.js";
import type { PluginSearchProvider } from "../../../../shared/types/plugin.js";
import { SEARCH_PROVIDER_MAX_RESPONSE_BYTES } from "../../../../shared/config/pluginSearchProviders.js";

const flush = () => new Promise((r) => setImmediate(r));

const IDENTITY = {
  instanceId: "acme.people",
  manifestId: "acme.people",
  origin: "global" as const,
  projectId: null,
  projectRoot: null,
};

class FakeWorkerHost extends EventEmitter {
  sent: any[] = [];
  ready = true;
  proxy: PluginDevWorkerHostProxy | null = null;
  send = vi.fn((msg: any) => {
    this.sent.push(msg);
    this.proxy?.handleMessage(msg);
    return this.ready;
  });
  isReady = () => this.ready;
  off = this.removeListener;
  dispose = vi.fn(() => {
    this.ready = false;
    this.removeAllListeners();
  });
}

interface Binding {
  id: string;
  provider: PluginSearchProvider;
  dispose: ReturnType<typeof vi.fn>;
}

function makeConnectedPair() {
  const bindings: Binding[] = [];
  const host = {
    pluginId: "acme.people",
    registerSearchProvider: vi.fn((id: string, provider: PluginSearchProvider) => {
      const dispose = vi.fn();
      bindings.push({ id, provider, dispose });
      return Promise.resolve(dispose);
    }),
  };
  const workerHost = new FakeWorkerHost();
  const bridge = new PluginDevWorkerMainBridge({
    pluginId: "acme.people",
    host: host as any,
    workerHost: workerHost as any,
    getCapabilities: () => [],
    clearPriorRegistrations: vi.fn(),
    onActivationResult: vi.fn(),
  });
  bridge.waitForActivation().catch(() => {});
  const proxy = new PluginDevWorkerHostProxy(
    "acme.people",
    (msg) => workerHost.emit("worker-message", msg),
    IDENTITY
  );
  workerHost.proxy = proxy;
  return { host, bindings, workerHost, proxy };
}

describe("search providers over the worker bridge", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks the worker's provider and hands main its answer, cut to the limit", async () => {
    const { host, bindings, proxy } = makeConnectedPair();
    const provider = vi.fn<PluginSearchProvider>(async (query) => [
      { id: "1", label: `${query} one` },
      { id: "2", label: `${query} two` },
      { id: "3", label: `${query} three` },
    ]);
    await proxy.host.registerSearchProvider("people", provider);
    await flush();

    expect(host.registerSearchProvider).toHaveBeenCalledTimes(1);
    const [binding] = bindings;
    expect(binding!.id).toBe("people");
    expect(binding!.provider).not.toBe(provider);

    const signal = new AbortController().signal;
    await expect(binding!.provider("ann", { mode: "blended", limit: 2, signal })).resolves.toEqual([
      { id: "1", label: "ann one" },
      { id: "2", label: "ann two" },
    ]);
    const [query, context] = provider.mock.calls[0]!;
    expect(query).toBe("ann");
    expect(context).toMatchObject({ mode: "blended", limit: 2 });
    expect(context.signal.aborted).toBe(false);
  });

  it("aborts the worker's signal when main cancels, and drops the late answer", async () => {
    const { bindings, proxy, workerHost } = makeConnectedPair();
    let workerSignal: AbortSignal | undefined;
    let answer: ((rows: { id: string; label: string }[]) => void) | undefined;
    await proxy.host.registerSearchProvider("people", (_query, context) => {
      workerSignal = context.signal;
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    await flush();

    const controller = new AbortController();
    const pending = bindings[0]!.provider("ann", {
      mode: "scoped",
      limit: 20,
      signal: controller.signal,
    });
    await flush();
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(workerHost.sent).toContainEqual(expect.objectContaining({ type: "invoke-cancel" }));
    expect(workerSignal?.aborted).toBe(true);

    const posted: any[] = [];
    workerHost.on("worker-message", (msg) => posted.push(msg));
    answer?.([{ id: "late", label: "Late" }]);
    await flush();
    expect(posted.filter((msg) => msg.type === "invoke-result")).toEqual([]);
  });

  it("fails an answer over the size limit in the worker", async () => {
    const { bindings, proxy } = makeConnectedPair();
    await proxy.host.registerSearchProvider("people", () => [
      { id: "1", label: "x".repeat(SEARCH_PROVIDER_MAX_RESPONSE_BYTES) },
    ]);
    await flush();
    await expect(
      bindings[0]!.provider("ann", {
        mode: "scoped",
        limit: 20,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/byte limit/);
  });

  it("unbinds on dispose, but a disposer a later binding replaced leaves it in place", async () => {
    const { bindings, proxy } = makeConnectedPair();
    const disposeFirst = await proxy.host.registerSearchProvider("people", () => []);
    await flush();
    const disposeSecond = await proxy.host.registerSearchProvider("people", () => []);
    await flush();

    // The replacement released the first host binding when it took over.
    expect(bindings).toHaveLength(2);
    expect(bindings[0]!.dispose).toHaveBeenCalledTimes(1);

    disposeFirst();
    await flush();
    expect(bindings[1]!.dispose).not.toHaveBeenCalled();

    disposeSecond();
    await flush();
    expect(bindings[1]!.dispose).toHaveBeenCalledTimes(1);
  });

  it("refuses a provider that isn't a function", () => {
    const { proxy } = makeConnectedPair();
    expect(() => proxy.host.registerSearchProvider("people", "nope" as never)).toThrow(
      /must be a function/
    );
  });
});
