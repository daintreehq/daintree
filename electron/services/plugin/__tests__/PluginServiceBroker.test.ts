// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginServiceBroker, type PluginServiceMethodRunner } from "../PluginServiceBroker.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";
import { runWithServiceInvocation } from "../pluginServiceInvocation.js";
import type {
  PluginServiceCallContext,
  PluginServiceResult,
  PluginServicesContribution,
} from "../../../../shared/types/pluginServices.js";
import { makeProjectPluginInstanceKey } from "../../../../shared/types/plugin.js";
import {
  PLUGIN_SERVICE_MAX_ARGS_BYTES,
  PLUGIN_SERVICE_MAX_CONCURRENT_CALLS,
  PLUGIN_SERVICE_MAX_MESSAGE_LENGTH,
} from "../../../../shared/config/pluginBudgets.js";

const PROJECT = "a".repeat(64);
const OTHER_PROJECT = "b".repeat(64);
const ISSUES = "acme.jira.issues";

function services(partial: Partial<PluginServicesContribution>): PluginServicesContribution {
  return { provides: partial.provides ?? [], requires: partial.requires ?? [] };
}

function plugin(
  name: string,
  svc: Partial<PluginServicesContribution>,
  capabilities: string[] = []
): LoadedPlugin {
  return {
    manifest: { name, version: "1.0.0", capabilities, contributes: { services: services(svc) } },
    dir: `/plugins/${name}`,
    loadedAt: 0,
    isBuiltin: true,
  } as unknown as LoadedPlugin;
}

const consumerOf = (range = "^1.0.0", optional?: boolean) =>
  plugin("acme.app", {
    requires: [{ name: ISSUES, range, ...(optional === undefined ? {} : { optional }) }],
  });

const providerOf = (version = "1.2.0", methods = ["lookup"], capabilities: string[] = []) =>
  plugin("acme.jira", { provides: [{ name: ISSUES, version, methods }] }, capabilities);

function setup() {
  const plugins = new Map<string, LoadedPlugin>();
  const activated = new Set<string>();
  const hidden = new Set<string>();
  const onActivate = new Map<string, () => void>();
  const reports: Array<{ pluginId: string; message: string }> = [];
  const activatePlugin = vi.fn(async (id: string) => {
    if (!plugins.has(id) || activated.has(id)) return;
    onActivate.get(id)?.();
    activated.add(id);
  });
  const broker = new PluginServiceBroker({
    getPlugin: (id) => plugins.get(id),
    isVisibleInProject: (id, projectId) => !hidden.has(`${id}|${projectId}`),
    isActivated: (id) => activated.has(id),
    activatePlugin,
    reportUnresolvedRequired: (pluginId, message) => reports.push({ pluginId, message }),
  });
  const load = (id: string, loaded: LoadedPlugin, activate?: () => void) => {
    plugins.set(id, loaded);
    if (activate) onActivate.set(id, activate);
  };
  /** A consumer instance that has finished activating. */
  const loadConsumer = (id: string, loaded: LoadedPlugin) => {
    load(id, loaded);
    activated.add(id);
  };
  const consumer = (id = "acme.app", projectId: string | null = null) => ({
    instanceId: id,
    projectId,
  });
  return {
    broker,
    plugins,
    activated,
    hidden,
    reports,
    activatePlugin,
    load,
    loadConsumer,
    consumer,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function expectFailure(result: PluginServiceResult, reason: string) {
  expect(result.ok).toBe(false);
  if (result.ok) return "";
  expect(result.reason).toBe(reason);
  return result.message;
}

describe("PluginServiceBroker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a provider on the first call and runs its method with a host-authored caller", async () => {
    const t = setup();
    t.loadConsumer("acme.app", consumerOf());
    const seen: Array<{ args: unknown; ctx: PluginServiceCallContext }> = [];
    t.load("acme.jira", providerOf(), () => {
      t.broker.bind("acme.jira", t.plugins.get("acme.jira")!, ISSUES, (method, args, ctx) => {
        seen.push({ args, ctx });
        return { method, key: (args as { key: string }).key };
      });
    });

    const args = { key: "ABC-1" };
    const result = await t.broker.call(t.consumer(), ISSUES, "lookup", args);

    expect(result).toEqual({ ok: true, value: { method: "lookup", key: "ABC-1" } });
    expect(t.activatePlugin).toHaveBeenCalledWith("acme.jira");
    expect(seen[0].ctx.caller).toEqual({ pluginId: "acme.app", projectId: null });
    // The provider gets a copy, never the caller's own object.
    expect(seen[0].args).toEqual(args);
    expect(seen[0].args).not.toBe(args);
    expect(Object.keys(seen[0].ctx).sort()).toEqual(["caller", "signal"]);
  });

  it("answers not-declared for a service the caller didn't list in requires", async () => {
    const t = setup();
    t.loadConsumer("acme.app", plugin("acme.app", {}));
    t.load("acme.jira", providerOf());
    expectFailure(await t.broker.call(t.consumer(), ISSUES, "lookup", {}), "not-declared");
    expect(t.broker.status(t.consumer(), ISSUES)).toMatchObject({
      available: false,
      required: false,
      reason: "not-declared",
    });
    expect(t.activatePlugin).not.toHaveBeenCalled();
    expect(t.reports).toEqual([]);
  });

  it("answers unavailable for a missing provider and logs a required import once", async () => {
    const t = setup();
    t.loadConsumer("acme.app", consumerOf());
    expectFailure(await t.broker.call(t.consumer(), ISSUES, "lookup", {}), "unavailable");
    expectFailure(await t.broker.call(t.consumer(), ISSUES, "lookup", {}), "unavailable");
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0].pluginId).toBe("acme.app");
    expect(t.reports[0].message).toContain(ISSUES);
  });

  it("answers unavailable for a missing optional provider without logging it", async () => {
    const t = setup();
    t.loadConsumer("acme.app", consumerOf("^1.0.0", true));
    expectFailure(await t.broker.call(t.consumer(), ISSUES, "lookup", {}), "unavailable");
    const status = t.broker.status(t.consumer(), ISSUES);
    expect(status).toMatchObject({ available: false, required: false, reason: "unavailable" });
    expect(t.reports).toEqual([]);
  });

  it("answers incompatible, naming the version on offer, when none satisfies the range", async () => {
    const t = setup();
    t.loadConsumer("acme.app", consumerOf("^1.0.0"));
    t.load("acme.jira", providerOf("2.0.0"));
    const message = expectFailure(
      await t.broker.call(t.consumer(), ISSUES, "lookup", {}),
      "incompatible"
    );
    expect(message).toContain("2.0.0");
    expect(message).toContain("^1.0.0");
    expect(t.activatePlugin).not.toHaveBeenCalled();
  });

  it("refuses calls made before the caller's activate() has returned", async () => {
    const t = setup();
    t.load("acme.app", consumerOf());
    t.load("acme.jira", providerOf());
    expectFailure(await t.broker.call(t.consumer(), ISSUES, "lookup", {}), "unavailable");
    expect(t.activatePlugin).not.toHaveBeenCalled();
  });

  it("holds a call to a bound provider until its activate() has finished", async () => {
    const t = setup();
    t.loadConsumer("acme.app", consumerOf());
    t.load("acme.jira", providerOf());
    const finishing = deferred<void>();
    const run = vi.fn<PluginServiceMethodRunner>(() => "ready");
    let bound = false;
    // Binds early in activate(), then keeps setting up.
    t.activatePlugin.mockImplementation(async (id: string) => {
      if (t.activated.has(id)) return;
      if (!bound) {
        bound = true;
        t.broker.bind(id, t.plugins.get(id)!, ISSUES, run);
      }
      await finishing.promise;
      t.activated.add(id);
    });
    const first = t.broker.call(t.consumer(), ISSUES, "lookup", {});
    await vi.waitFor(() =>
      expect(t.broker.status(t.consumer(), ISSUES)).toMatchObject({ running: true })
    );
    // Bound, but still inside activate(): the second call waits too.
    const second = t.broker.call(t.consumer(), ISSUES, "lookup", {});
    await flush();
    expect(run).not.toHaveBeenCalled();
    finishing.resolve();
    expect(await first).toEqual({ ok: true, value: "ready" });
    expect(await second).toEqual({ ok: true, value: "ready" });
  });

  it("answers unavailable when the provider fails to start, even having bound the service", async () => {
    const t = setup();
    t.loadConsumer("acme.app", consumerOf());
    t.load("acme.jira", providerOf());
    const run = vi.fn<PluginServiceMethodRunner>(() => "never");
    // Binds, then its activate() throws: the host never marks it activated.
    t.activatePlugin.mockImplementation(async (id: string) => {
      t.broker.bind(id, t.plugins.get(id)!, ISSUES, run);
    });
    const message = expectFailure(
      await t.broker.call(t.consumer(), ISSUES, "lookup", {}),
      "unavailable"
    );
    expect(message).toContain("failed to start");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to bind for a load that has since been replaced", () => {
    const t = setup();
    t.load("acme.jira", providerOf());
    const outgoing = t.plugins.get("acme.jira")!;
    t.load("acme.jira", providerOf());
    expect(() => t.broker.bind("acme.jira", outgoing, ISSUES, () => "stale")).toThrow(
      "no longer loaded"
    );
  });

  it("answers unavailable when the provider starts without registering the service", async () => {
    const t = setup();
    t.loadConsumer("acme.app", consumerOf());
    t.load("acme.jira", providerOf());
    const message = expectFailure(
      await t.broker.call(t.consumer(), ISSUES, "lookup", {}),
      "unavailable"
    );
    expect(message).toContain("didn't register");
  });

  describe("binding resolution", () => {
    const projectConsumerId = makeProjectPluginInstanceKey(PROJECT, "acme.app");
    const projectProviderId = makeProjectPluginInstanceKey(PROJECT, "acme.jira");

    function bindAnswering(t: ReturnType<typeof setup>, id: string) {
      t.broker.bind(id, t.plugins.get(id)!, ISSUES, () => id);
    }

    it("prefers the provider in the caller's own project over the app-global one", async () => {
      const t = setup();
      t.loadConsumer(projectConsumerId, consumerOf());
      t.load(projectProviderId, providerOf("1.0.0"), () => bindAnswering(t, projectProviderId));
      t.load("acme.jira", providerOf("1.5.0"), () => bindAnswering(t, "acme.jira"));

      const result = await t.broker.call(
        t.consumer(projectConsumerId, PROJECT),
        ISSUES,
        "lookup",
        {}
      );
      expect(result).toEqual({ ok: true, value: projectProviderId });
      expect(t.broker.status(t.consumer(projectConsumerId, PROJECT), ISSUES)).toMatchObject({
        available: true,
        provider: { pluginId: "acme.jira", projectId: PROJECT, version: "1.0.0" },
      });
    });

    it("falls back to the app-global provider, unless the project has it switched off", async () => {
      const t = setup();
      t.loadConsumer(projectConsumerId, consumerOf());
      t.load("acme.jira", providerOf(), () => bindAnswering(t, "acme.jira"));
      const caller = t.consumer(projectConsumerId, PROJECT);

      expect(await t.broker.call(caller, ISSUES, "lookup", {})).toEqual({
        ok: true,
        value: "acme.jira",
      });
      t.hidden.add(`acme.jira|${PROJECT}`);
      expectFailure(await t.broker.call(caller, ISSUES, "lookup", {}), "unavailable");
    });

    it("never reaches another project's provider, nor any project's from an app-global caller", async () => {
      const t = setup();
      t.loadConsumer("acme.app", consumerOf());
      const otherConsumerId = makeProjectPluginInstanceKey(OTHER_PROJECT, "acme.app");
      t.loadConsumer(otherConsumerId, consumerOf());
      t.load(projectProviderId, providerOf(), () => bindAnswering(t, projectProviderId));

      expectFailure(await t.broker.call(t.consumer(), ISSUES, "lookup", {}), "unavailable");
      expectFailure(
        await t.broker.call(t.consumer(otherConsumerId, OTHER_PROJECT), ISSUES, "lookup", {}),
        "unavailable"
      );
      expect(t.activatePlugin).not.toHaveBeenCalled();
    });

    it("discloses the provider's capabilities and whether it is running", async () => {
      const t = setup();
      t.loadConsumer("acme.app", consumerOf());
      t.load("acme.jira", providerOf("1.2.0", ["lookup"], ["network:fetch"]), () =>
        bindAnswering(t, "acme.jira")
      );
      expect(t.broker.status(t.consumer(), ISSUES)).toEqual({
        available: true,
        required: true,
        running: false,
        provider: {
          pluginId: "acme.jira",
          projectId: null,
          version: "1.2.0",
          methods: ["lookup"],
          capabilities: ["network:fetch"],
        },
      });
      await t.broker.call(t.consumer(), ISSUES, "lookup", {});
      expect(t.broker.status(t.consumer(), ISSUES)).toMatchObject({ running: true });
    });
  });

  describe("validation and bounds", () => {
    function ready() {
      const t = setup();
      t.loadConsumer("acme.app", consumerOf());
      const run = vi.fn<PluginServiceMethodRunner>(() => "ok");
      t.load("acme.jira", providerOf(), () =>
        t.broker.bind("acme.jira", t.plugins.get("acme.jira")!, ISSUES, run)
      );
      return { ...t, run };
    }

    it("rejects an undeclared method, bad options and uncopyable arguments before running anything", async () => {
      const t = ready();
      expectFailure(await t.broker.call(t.consumer(), ISSUES, "delete", {}), "invalid");
      expectFailure(
        await t.broker.call(t.consumer(), ISSUES, "lookup", {}, { timeoutMs: 0 }),
        "invalid"
      );
      expectFailure(
        await t.broker.call(t.consumer(), ISSUES, "lookup", { fn: () => 1 }),
        "invalid"
      );
      expect(t.run).not.toHaveBeenCalled();
    });

    it("refuses arguments and results over their size limits", async () => {
      const t = ready();
      const big = "x".repeat(PLUGIN_SERVICE_MAX_ARGS_BYTES + 1);
      expectFailure(await t.broker.call(t.consumer(), ISSUES, "lookup", big), "payload-too-large");
      t.run.mockReturnValue("y".repeat(2 * 1024 * 1024));
      expectFailure(await t.broker.call(t.consumer(), ISSUES, "lookup", {}), "payload-too-large");
    });

    it("bounds the message a provider's error carries back", async () => {
      const t = ready();
      t.run.mockImplementation(() => {
        throw new Error("x".repeat(10 * PLUGIN_SERVICE_MAX_MESSAGE_LENGTH));
      });
      const message = expectFailure(
        await t.broker.call(t.consumer(), ISSUES, "lookup", {}),
        "provider-error"
      );
      expect(message.length).toBeLessThanOrEqual(PLUGIN_SERVICE_MAX_MESSAGE_LENGTH);
    });

    it("reports a provider that throws as provider-error with its message", async () => {
      const t = ready();
      t.run.mockImplementation(() => {
        throw new Error("Jira said no");
      });
      const message = expectFailure(
        await t.broker.call(t.consumer(), ISSUES, "lookup", {}),
        "provider-error"
      );
      expect(message).toContain("Jira said no");
    });

    it("refuses a call past the provider's concurrent-call limit", async () => {
      const t = ready();
      const hold = deferred();
      t.run.mockImplementation(() => hold.promise);
      const running = Array.from({ length: PLUGIN_SERVICE_MAX_CONCURRENT_CALLS }, () =>
        t.broker.call(t.consumer(), ISSUES, "lookup", {})
      );
      await vi.waitFor(() =>
        expect(t.run).toHaveBeenCalledTimes(PLUGIN_SERVICE_MAX_CONCURRENT_CALLS)
      );
      expectFailure(await t.broker.call(t.consumer(), ISSUES, "lookup", {}), "unavailable");
      hold.resolve("done");
      for (const result of await Promise.all(running)) expect(result.ok).toBe(true);
    });
  });

  it("holds no timer once its calls have settled, whether answered or cancelled", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.loadConsumer("acme.app", consumerOf());
    const hold = deferred();
    let answer = true;
    t.load("acme.jira", providerOf(), () =>
      t.broker.bind("acme.jira", t.plugins.get("acme.jira")!, ISSUES, () =>
        answer ? "now" : hold.promise
      )
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(await t.broker.call(t.consumer(), ISSUES, "lookup", {})).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);

    answer = false;
    const controller = new AbortController();
    const pending = t.broker.call(
      t.consumer(),
      ISSUES,
      "lookup",
      {},
      { signal: controller.signal }
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expectFailure(await pending, "cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("cancellation and deadlines", () => {
    function hanging() {
      const t = setup();
      t.loadConsumer("acme.app", consumerOf());
      let providerSignal: AbortSignal | undefined;
      const run = vi.fn<PluginServiceMethodRunner>((_m, _a, ctx) => {
        providerSignal = ctx.signal;
        return new Promise(() => {});
      });
      t.load("acme.jira", providerOf(), () =>
        t.broker.bind("acme.jira", t.plugins.get("acme.jira")!, ISSUES, run)
      );
      return { ...t, run, providerSignal: () => providerSignal };
    }

    it("settles as cancelled when the caller aborts, and aborts the provider's signal", async () => {
      const t = hanging();
      const controller = new AbortController();
      const result = t.broker.call(
        t.consumer(),
        ISSUES,
        "lookup",
        {},
        { signal: controller.signal }
      );
      await vi.waitFor(() => expect(t.run).toHaveBeenCalled());
      controller.abort();
      expectFailure(await result, "cancelled");
      expect(t.providerSignal()?.aborted).toBe(true);
    });

    it("never starts a call whose signal is already aborted", async () => {
      const t = hanging();
      const controller = new AbortController();
      controller.abort();
      expectFailure(
        await t.broker.call(t.consumer(), ISSUES, "lookup", {}, { signal: controller.signal }),
        "cancelled"
      );
      expect(t.activatePlugin).not.toHaveBeenCalled();
    });

    it("settles as timeout at its deadline, and aborts the provider's signal", async () => {
      vi.useFakeTimers();
      const t = hanging();
      const result = t.broker.call(t.consumer(), ISSUES, "lookup", {}, { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(49);
      expect(t.run).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expectFailure(await result, "timeout");
      expect(t.providerSignal()?.aborted).toBe(true);
    });

    it("counts starting the provider against the deadline", async () => {
      vi.useFakeTimers();
      const t = setup();
      t.loadConsumer("acme.app", consumerOf());
      t.load("acme.jira", providerOf());
      t.activatePlugin.mockImplementation(() => new Promise(() => {}));
      const result = t.broker.call(t.consumer(), ISSUES, "lookup", {}, { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      expectFailure(await result, "timeout");
    });
  });

  describe("instance replacement", () => {
    it("settles an in-flight call as unavailable when the provider unloads, and the next call reaches its replacement", async () => {
      const t = setup();
      t.loadConsumer("acme.app", consumerOf());
      let providerSignal: AbortSignal | undefined;
      t.load("acme.jira", providerOf(), () =>
        t.broker.bind("acme.jira", t.plugins.get("acme.jira")!, ISSUES, (_m, _a, ctx) => {
          providerSignal = ctx.signal;
          return new Promise(() => {});
        })
      );
      const inFlight = t.broker.call(t.consumer(), ISSUES, "lookup", {});
      await vi.waitFor(() => expect(providerSignal).toBeDefined());

      // Unload: the broker retires the instance, then the id loads afresh.
      t.broker.retireInstance("acme.jira");
      t.activated.delete("acme.jira");
      expectFailure(await inFlight, "unavailable");
      expect(providerSignal?.aborted).toBe(true);

      t.load("acme.jira", providerOf("1.3.0"), () =>
        t.broker.bind("acme.jira", t.plugins.get("acme.jira")!, ISSUES, () => "replacement")
      );
      expect(await t.broker.call(t.consumer(), ISSUES, "lookup", {})).toEqual({
        ok: true,
        value: "replacement",
      });
    });

    it("settles calls on a binding that is registered again as unavailable", async () => {
      const t = setup();
      t.loadConsumer("acme.app", consumerOf());
      t.load("acme.jira", providerOf(), () =>
        t.broker.bind("acme.jira", t.plugins.get("acme.jira")!, ISSUES, () => new Promise(() => {}))
      );
      const inFlight = t.broker.call(t.consumer(), ISSUES, "lookup", {});
      await vi.waitFor(() => expect(t.activated.has("acme.jira")).toBe(true));
      const dispose = t.broker.bind(
        "acme.jira",
        t.plugins.get("acme.jira")!,
        ISSUES,
        () => "second"
      );
      expectFailure(await inFlight, "unavailable");
      expect(await t.broker.call(t.consumer(), ISSUES, "lookup", {})).toEqual({
        ok: true,
        value: "second",
      });
      dispose();
      expect(t.broker.status(t.consumer(), ISSUES)).toMatchObject({ running: false });
    });

    it("ignores a binding left by an earlier load of the same id", async () => {
      const t = setup();
      t.loadConsumer("acme.app", consumerOf());
      t.load("acme.jira", providerOf());
      t.broker.bind("acme.jira", t.plugins.get("acme.jira")!, ISSUES, () => "stale");
      // Reloaded as a fresh object without the old binding being retired.
      t.load("acme.jira", providerOf(), () =>
        t.broker.bind("acme.jira", t.plugins.get("acme.jira")!, ISSUES, () => "fresh")
      );
      expect(await t.broker.call(t.consumer(), ISSUES, "lookup", {})).toEqual({
        ok: true,
        value: "fresh",
      });
    });

    it("answers unavailable when the provider is replaced while it starts", async () => {
      const t = setup();
      t.loadConsumer("acme.app", consumerOf());
      t.load("acme.jira", providerOf());
      const starting = deferred<void>();
      t.activatePlugin.mockImplementation(() => starting.promise);
      const result = t.broker.call(t.consumer(), ISSUES, "lookup", {});
      await vi.waitFor(() => expect(t.activatePlugin).toHaveBeenCalled());
      t.load("acme.jira", providerOf());
      t.broker.bind("acme.jira", t.plugins.get("acme.jira")!, ISSUES, () => "replacement");
      starting.resolve();
      expectFailure(await result, "unavailable");
    });

    it("cancels the calls a plugin made when it unloads", async () => {
      const t = setup();
      t.loadConsumer("acme.app", consumerOf());
      t.load("acme.jira", providerOf(), () =>
        t.broker.bind("acme.jira", t.plugins.get("acme.jira")!, ISSUES, () => new Promise(() => {}))
      );
      const inFlight = t.broker.call(t.consumer(), ISSUES, "lookup", {});
      await vi.waitFor(() => expect(t.activated.has("acme.jira")).toBe(true));
      t.broker.retireInstance("acme.app");
      expectFailure(await inFlight, "cancelled");
    });
  });

  describe("calls that outlive their call", () => {
    it("refuses a call the method's leftover work starts after its own call ended", async () => {
      const t = setup();
      t.loadConsumer("acme.app", consumerOf());
      const B = "acme.beta.svc";
      const late = deferred<PluginServiceResult>();
      const betaRun = vi.fn<PluginServiceMethodRunner>(() => "reached");
      t.load(
        "acme.jira",
        plugin("acme.jira", {
          provides: [{ name: ISSUES, version: "1.0.0", methods: ["lookup"] }],
          requires: [{ name: B, range: "^1.0.0" }],
        }),
        () =>
          t.broker.bind("acme.jira", t.plugins.get("acme.jira")!, ISSUES, () => {
            setTimeout(() => {
              void t.broker.call(t.consumer("acme.jira"), B, "run", {}).then(late.resolve);
            }, 0);
            return "done";
          })
      );
      t.load(
        "acme.beta",
        plugin("acme.beta", { provides: [{ name: B, version: "1.0.0", methods: ["run"] }] }),
        () => t.broker.bind("acme.beta", t.plugins.get("acme.beta")!, B, betaRun)
      );
      expect(await t.broker.call(t.consumer(), ISSUES, "lookup", {})).toEqual({
        ok: true,
        value: "done",
      });
      expectFailure(await late.promise, "cancelled");
      expect(betaRun).not.toHaveBeenCalled();
    });

    it("refuses a nested call once the outer call's deadline has passed", async () => {
      const t = setup();
      t.loadConsumer("acme.app", consumerOf());
      const run = vi.fn<PluginServiceMethodRunner>(() => "late");
      t.load("acme.jira", providerOf(), () =>
        t.broker.bind("acme.jira", t.plugins.get("acme.jira")!, ISSUES, run)
      );
      const expired = {
        chain: [],
        deadlineAt: Date.now() - 1,
        signal: new AbortController().signal,
      };
      const result = await runWithServiceInvocation(expired, () =>
        t.broker.call(t.consumer(), ISSUES, "lookup", {})
      );
      expectFailure(result, "timeout");
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe("cycles", () => {
    const A = "acme.alpha.svc";
    const B = "acme.beta.svc";

    it("refuses a call that would re-enter a service already waiting on it", async () => {
      const t = setup();
      t.loadConsumer("acme.app", plugin("acme.app", { requires: [{ name: A, range: "^1.0.0" }] }));
      t.load(
        "acme.alpha",
        plugin("acme.alpha", {
          provides: [{ name: A, version: "1.0.0", methods: ["run"] }],
          requires: [{ name: B, range: "^1.0.0" }],
        }),
        () =>
          t.broker.bind("acme.alpha", t.plugins.get("acme.alpha")!, A, () =>
            t.broker.call(t.consumer("acme.alpha"), B, "run", {})
          )
      );
      t.load(
        "acme.beta",
        plugin("acme.beta", {
          provides: [{ name: B, version: "1.0.0", methods: ["run"] }],
          requires: [{ name: A, range: "^1.0.0" }],
        }),
        () =>
          t.broker.bind("acme.beta", t.plugins.get("acme.beta")!, B, () =>
            t.broker.call(t.consumer("acme.beta"), A, "run", {})
          )
      );
      // Each provider must have finished activating to call out.
      await t.activatePlugin("acme.alpha");
      await t.activatePlugin("acme.beta");

      const result = await t.broker.call(t.consumer(), A, "run", {});
      // alpha → beta → alpha: the innermost call is refused, and the refusal is
      // what beta and then alpha answered with.
      expect(result.ok).toBe(true);
      const inner = (result as { value: { value: PluginServiceResult } }).value.value;
      expect(inner).toMatchObject({ ok: false, reason: "cycle" });
      expect((inner as { message: string }).message).toContain(`${A} → ${B} → ${A}`);
    });

    it("keeps concurrent call chains apart", async () => {
      const t = setup();
      t.loadConsumer("acme.app", plugin("acme.app", { requires: [{ name: A, range: "^1.0.0" }] }));
      t.loadConsumer(
        "acme.other",
        plugin("acme.other", { requires: [{ name: A, range: "^1.0.0" }] })
      );
      const gate = deferred();
      t.load(
        "acme.alpha",
        plugin("acme.alpha", { provides: [{ name: A, version: "1.0.0", methods: ["run"] }] }),
        () =>
          t.broker.bind("acme.alpha", t.plugins.get("acme.alpha")!, A, async (_m, args) => {
            await gate.promise;
            return args;
          })
      );
      const first = t.broker.call(t.consumer(), A, "run", 1);
      const second = t.broker.call(t.consumer("acme.other"), A, "run", 2);
      gate.resolve(undefined);
      expect(await first).toEqual({ ok: true, value: 1 });
      expect(await second).toEqual({ ok: true, value: 2 });
    });

    it("cancels a nested call when the call it was made inside times out", async () => {
      vi.useFakeTimers();
      const t = setup();
      t.loadConsumer("acme.app", plugin("acme.app", { requires: [{ name: A, range: "^1.0.0" }] }));
      let nested: Promise<PluginServiceResult> | undefined;
      t.load(
        "acme.alpha",
        plugin("acme.alpha", {
          provides: [{ name: A, version: "1.0.0", methods: ["run"] }],
          requires: [{ name: B, range: "^1.0.0" }],
        }),
        () =>
          t.broker.bind("acme.alpha", t.plugins.get("acme.alpha")!, A, () => {
            nested = t.broker.call(t.consumer("acme.alpha"), B, "run", {});
            return new Promise(() => {});
          })
      );
      t.load(
        "acme.beta",
        plugin("acme.beta", { provides: [{ name: B, version: "1.0.0", methods: ["run"] }] }),
        () =>
          t.broker.bind("acme.beta", t.plugins.get("acme.beta")!, B, () => new Promise(() => {}))
      );
      await t.activatePlugin("acme.alpha");

      const outer = t.broker.call(t.consumer(), A, "run", {}, { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      expectFailure(await outer, "timeout");
      expect(nested).toBeDefined();
      expectFailure(await nested!, "cancelled");
    });
  });
});
