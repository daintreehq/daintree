// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { PluginDevWorkerMainBridge } from "../PluginDevWorkerMainBridge.js";
import { PluginDevWorkerHostProxy } from "../pluginDevWorkerHostProxy.js";
import { PluginServiceBroker } from "../PluginServiceBroker.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";
import { PLUGIN_SERVICE_MAX_METHODS } from "../../../../shared/config/pluginBudgets.js";
import type {
  PluginServiceCallContext,
  PluginServiceResult,
  PluginServicesContribution,
} from "../../../../shared/types/pluginServices.js";

/**
 * Services between two plugin workers (#14105), end to end: each worker's
 * proxy is wired back to back with its main-side bridge, as the port wires
 * them, and both bridges reach one real broker — the path a call takes with
 * no renderer anywhere.
 */

class FakeWorkerHost extends EventEmitter {
  ready = true;
  send = vi.fn((_msg: any) => this.ready);
  isReady = () => this.ready;
  off = this.removeListener;
  dispose = vi.fn(() => {
    this.ready = false;
  });
}

const flush = () => new Promise((r) => setImmediate(r));

function world() {
  const plugins = new Map<string, LoadedPlugin>();
  const broker = new PluginServiceBroker({
    getPlugin: (id) => plugins.get(id),
    isVisibleInProject: () => true,
    isActivated: (id) => plugins.has(id),
    activatePlugin: async () => {},
    reportUnresolvedRequired: () => {},
  });

  function worker(id: string, services: Partial<PluginServicesContribution>) {
    plugins.set(id, {
      manifest: {
        name: id,
        version: "1.0.0",
        contributes: { services: { provides: [], requires: [], ...services } },
      },
      dir: `/plugins/${id}`,
      loadedAt: 0,
      isBuiltin: false,
    } as unknown as LoadedPlugin);
    // The service surface of the main-side host, wired as PluginHostFactory wires it.
    const mainHost = {
      registerService: async (name: string, handlers: Record<string, any>) =>
        broker.bind(id, plugins.get(id)!, name, (method, args, ctx) => handlers[method](args, ctx)),
      services: {
        call: (name: string, method: string, args: unknown, options?: unknown) =>
          broker.call({ instanceId: id, projectId: null }, name, method, args, options),
        status: async (name: string) => broker.status({ instanceId: id, projectId: null }, name),
      },
    };
    const workerHost = new FakeWorkerHost();
    const bridge = new PluginDevWorkerMainBridge({
      pluginId: id,
      host: mainHost as any,
      workerHost: workerHost as any,
      getCapabilities: () => [],
      clearPriorRegistrations: () => {},
      onActivationResult: () => {},
      onTerminalFailure: () => {},
      onPushRejected: () => {},
    });
    const proxy = new PluginDevWorkerHostProxy(
      id,
      (msg) => workerHost.emit("worker-message", msg),
      { instanceId: id, manifestId: id, origin: "global", projectId: null, projectRoot: null }
    );
    workerHost.send.mockImplementation((msg: any) => {
      proxy.handleMessage(msg);
      return workerHost.ready;
    });
    return { bridge, proxy, workerHost, host: proxy.host };
  }

  return { broker, worker };
}

const ISSUES = "acme.jira.issues";

describe("services between plugin workers", () => {
  it("runs a worker provider's method for a worker consumer and returns a typed result", async () => {
    const w = world();
    const provider = w.worker("acme.jira", {
      provides: [{ name: ISSUES, version: "1.0.0", methods: ["lookup"] }],
    });
    const consumer = w.worker("acme.app", { requires: [{ name: ISSUES, range: "^1.0.0" }] });
    await provider.host.registerService(ISSUES, {
      lookup: async (args: unknown, ctx: PluginServiceCallContext) => ({
        key: (args as { key: string }).key,
        caller: ctx.caller,
      }),
    });
    await flush();

    await expect(consumer.host.services.status(ISSUES)).resolves.toMatchObject({
      available: true,
      running: true,
      provider: { pluginId: "acme.jira", version: "1.0.0" },
    });
    await expect(consumer.host.services.call(ISSUES, "lookup", { key: "ABC-1" })).resolves.toEqual({
      ok: true,
      value: { key: "ABC-1", caller: { pluginId: "acme.app", projectId: null } },
    });
  });

  it("resolves a cancelled call as cancelled and aborts the provider worker's signal", async () => {
    const w = world();
    const provider = w.worker("acme.jira", {
      provides: [{ name: ISSUES, version: "1.0.0", methods: ["lookup"] }],
    });
    const consumer = w.worker("acme.app", { requires: [{ name: ISSUES, range: "^1.0.0" }] });
    let providerSignal: AbortSignal | undefined;
    await provider.host.registerService(ISSUES, {
      lookup: (_args: unknown, ctx: PluginServiceCallContext) => {
        providerSignal = ctx.signal;
        return new Promise(() => {});
      },
    });
    await flush();

    const controller = new AbortController();
    const result = consumer.host.services.call(ISSUES, "lookup", {}, { signal: controller.signal });
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    controller.abort();
    await expect(result).resolves.toMatchObject({ ok: false, reason: "cancelled" });
    expect(providerSignal?.aborted).toBe(true);
  });

  it("answers unavailable when the provider's worker crashes mid-call", async () => {
    const w = world();
    const provider = w.worker("acme.jira", {
      provides: [{ name: ISSUES, version: "1.0.0", methods: ["lookup"] }],
    });
    const consumer = w.worker("acme.app", { requires: [{ name: ISSUES, range: "^1.0.0" }] });
    let started = false;
    await provider.host.registerService(ISSUES, {
      lookup: () => {
        started = true;
        return new Promise(() => {});
      },
    });
    await flush();

    const result = consumer.host.services.call(ISSUES, "lookup", {});
    await vi.waitFor(() => expect(started).toBe(true));
    provider.workerHost.emit("exit", 139, false);
    await expect(result).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    // The crashed generation's binding is gone until the replacement registers.
    await expect(consumer.host.services.status(ISSUES)).resolves.toMatchObject({
      running: false,
    });
  });

  it("refuses a call that cycles back through both workers", async () => {
    const w = world();
    const A = "acme.alpha.svc";
    const B = "acme.beta.svc";
    const alpha = w.worker("acme.alpha", {
      provides: [{ name: A, version: "1.0.0", methods: ["run"] }],
      requires: [{ name: B, range: "^1.0.0" }],
    });
    const beta = w.worker("acme.beta", {
      provides: [{ name: B, version: "1.0.0", methods: ["run"] }],
      requires: [{ name: A, range: "^1.0.0" }],
    });
    const app = w.worker("acme.app", { requires: [{ name: A, range: "^1.0.0" }] });
    await alpha.host.registerService(A, { run: () => alpha.host.services.call(B, "run", {}) });
    await beta.host.registerService(B, { run: () => beta.host.services.call(A, "run", {}) });
    await flush();

    const result = await app.host.services.call(A, "run", {});
    expect(result.ok).toBe(true);
    const inner = (result as { value: { value: PluginServiceResult } }).value.value;
    expect(inner).toMatchObject({ ok: false, reason: "cycle" });
  });

  it("refuses a call a provider makes after its own caller stopped waiting", async () => {
    const w = world();
    const A = "acme.alpha.svc";
    const B = "acme.beta.svc";
    const alpha = w.worker("acme.alpha", {
      provides: [{ name: A, version: "1.0.0", methods: ["run"] }],
      requires: [{ name: B, range: "^1.0.0" }],
    });
    const beta = w.worker("acme.beta", {
      provides: [{ name: B, version: "1.0.0", methods: ["run"] }],
    });
    const app = w.worker("acme.app", { requires: [{ name: A, range: "^1.0.0" }] });
    const betaRun = vi.fn(() => "reached");
    let late: Promise<PluginServiceResult> | undefined;
    await alpha.host.registerService(A, {
      run: async (_args: unknown, ctx: PluginServiceCallContext) => {
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
        // Still inside the cancelled call's invocation, after main stopped waiting.
        late = alpha.host.services.call(B, "run", {});
        return late;
      },
    });
    await beta.host.registerService(B, { run: betaRun });
    await flush();

    const controller = new AbortController();
    const outer = app.host.services.call(A, "run", {}, { signal: controller.signal });
    await flush();
    controller.abort();
    await expect(outer).resolves.toMatchObject({ ok: false, reason: "cancelled" });
    await vi.waitFor(() => expect(late).toBeDefined());
    await expect(late).resolves.toMatchObject({ ok: false, reason: "cancelled" });
    expect(betaRun).not.toHaveBeenCalled();
  });

  it("reports a worker result over the size limit as payload-too-large", async () => {
    const w = world();
    const provider = w.worker("acme.jira", {
      provides: [{ name: ISSUES, version: "1.0.0", methods: ["lookup"] }],
    });
    const consumer = w.worker("acme.app", { requires: [{ name: ISSUES, range: "^1.0.0" }] });
    await provider.host.registerService(ISSUES, { lookup: () => "x".repeat(2 * 1024 * 1024) });
    await flush();
    await expect(consumer.host.services.call(ISSUES, "lookup", {})).resolves.toMatchObject({
      ok: false,
      reason: "payload-too-large",
    });
  });

  it("binds nothing for a raw registration past the method bound", async () => {
    const w = world();
    const provider = w.worker("acme.jira", {
      provides: [{ name: ISSUES, version: "1.0.0", methods: ["lookup"] }],
    });
    const consumer = w.worker("acme.app", { requires: [{ name: ISSUES, range: "^1.0.0" }] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    provider.workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerService",
      registrationKey: `service:${ISSUES}`,
      params: {
        name: ISSUES,
        methods: Array.from({ length: PLUGIN_SERVICE_MAX_METHODS + 1 }, (_, i) => `m${i}`),
      },
    });
    await flush();
    errors.mockRestore();
    await expect(consumer.host.services.status(ISSUES)).resolves.toMatchObject({
      running: false,
    });
  });
});
