/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { PluginDevWorkerMainBridge } from "../PluginDevWorkerMainBridge.js";
import { PluginDevWorkerHostProxy } from "../pluginDevWorkerHostProxy.js";
import {
  bindPluginCloudProvider,
  clearPluginCloudProviders,
  pluginCloudProviderBinding,
  publishPluginCloudProviders,
  type PluginCloudProviderRuntime,
} from "../pluginCloudProviders.js";
import { PluginCloudProvider } from "../../../remote/cloud/PluginCloudProvider.js";
import type {
  CloudProviderContribution,
  CloudProviderImpl,
  CloudProviderResource,
} from "../../../../shared/types/pluginCloudProvider.js";
import type { PluginHostApi } from "../../../../shared/types/plugin.js";

const flush = () => new Promise((r) => setImmediate(r));

const PLUGIN_ID = "acme.devboxes";
const PROVIDER_ID = "acme.devboxes.devbox";

const IDENTITY = {
  instanceId: PLUGIN_ID,
  manifestId: PLUGIN_ID,
  origin: "global" as const,
  projectId: null,
  projectRoot: null,
};

/** The manifest entry the sample plugin ships. */
const DEVBOX: CloudProviderContribution = {
  id: "devbox",
  name: "Devbox",
  description: "Throwaway machines from a fake backend.",
  apiUrl: "https://api.devbox.example",
  apiKeyUrl: "https://devbox.example/keys",
  dashboardUrl: "https://devbox.example",
  docsUrl: "https://devbox.example/docs",
  credentialFields: [
    {
      id: "token",
      label: "API token",
      secret: true,
      input: "single-line",
      required: true,
      help: null,
    },
  ],
  capabilities: {
    persistence: {
      kept: "Its disk",
      lost: "Memory",
      retentionDays: null,
      saveRetryBilled: false,
      stoppedComputeBilled: false,
    },
    typicalStartSeconds: 30,
    lifetime: { kind: "none" },
    sshTrust: "confirm-on-first-connect",
    transport: "direct",
    tunnel: null,
    provisioning: { location: "none", image: "none", network: "none", sshKey: "at-create" },
    deletion: true,
  },
};

/**
 * The sample plugin: a cloud provider over an in-memory backend, written the
 * way an installed plugin would write it against the public contract.
 */
function sampleDevboxPlugin() {
  const machines = new Map<string, CloudProviderResource>();
  const byKey = new Map<string, string>();
  const seen: { method: string; credentials?: unknown; signal?: AbortSignal }[] = [];
  let nextId = 1;
  const refused = (code: string, message: string) => Object.assign(new Error(message), { code });
  const found = (resourceId: string) => {
    const machine = machines.get(resourceId);
    if (!machine) throw refused("not-found", `No machine ${resourceId}`);
    return machine;
  };
  const set = (resourceId: string, state: CloudProviderResource["machine"]) => {
    const machine = { ...found(resourceId), machine: state, rawState: state };
    machines.set(resourceId, machine);
    return machine;
  };
  const impl: CloudProviderImpl = {
    checkCredentials(values, apiUrl, signal) {
      seen.push({ method: "checkCredentials", credentials: { values, apiUrl }, signal });
      if (values.token !== "good-token")
        throw refused("credential-invalid", "That token was refused.");
      return {
        identity: "dev@example.com",
        scopes: [{ scope: { kind: "personal", id: "me", name: "Personal" }, active: true }],
      };
    },
    validate: () => ({ identity: "dev@example.com" }),
    catalog: () => ({
      machineTypes: [
        {
          id: "small",
          label: "Small",
          vcpu: 2,
          memoryGB: 4,
          hourlyDollars: 0.05,
          available: true,
          reason: null,
        },
      ],
      canStart: true,
      includedHoursRemaining: null,
      startsRemaining: null,
      savedSnapshotDayDollars: null,
    }),
    list: (_credentials, { label }) =>
      [...machines.values()].filter((machine) => {
        if (!label) return true;
        const [key, value] = label.split("=");
        return machine.labels[key!] === value;
      }),
    inspect: (_credentials, resourceId) => found(resourceId),
    create(credentials, request) {
      seen.push({ method: "create", credentials });
      const existing = byKey.get(request.idempotencyKey);
      if (existing) return found(existing);
      const resourceId = `dbx-${nextId++}`;
      const machine: CloudProviderResource = {
        resourceId,
        name: request.name,
        machine: "starting",
        rawState: "provisioning",
        machineType: request.machineType,
        vcpu: 2,
        memoryGB: 4,
        autoStopAt: null,
        lifetimeSeconds: null,
        stoppedAt: null,
        createdAt: "2026-11-18T00:00:00.000Z",
        stop: null,
        lastSnapshotAt: null,
        dataExpired: false,
        snapshotsDisabled: false,
        labels: request.labels,
        restricted: false,
        error: null,
      };
      machines.set(resourceId, machine);
      byKey.set(request.idempotencyKey, resourceId);
      return machine;
    },
    start: (_credentials, resourceId) => set(resourceId, "running"),
    stop: (_credentials, resourceId) => set(resourceId, "stopped"),
    rename(_credentials, resourceId, name) {
      machines.set(resourceId, { ...found(resourceId), name });
    },
    delete(_credentials, resourceId) {
      found(resourceId);
      machines.delete(resourceId);
    },
    sshAccess: (_credentials, resourceId) => {
      found(resourceId);
      return { user: "dev", endpoint: { host: "10.0.0.5", port: 22 }, hostKey: null };
    },
  };
  return {
    machines,
    seen,
    impl,
    activate: (host: Pick<PluginHostApi, "registerCloudProvider">) =>
      host.registerCloudProvider({ id: "devbox" }, impl),
  };
}

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

/**
 * Main's half (the bridge and the host's real binding into the provider
 * registry) wired to the worker's half (the host proxy the plugin activates
 * against) through a fake process port, so each call crosses the same
 * messages a forked worker's would.
 */
async function connected() {
  publishPluginCloudProviders(PLUGIN_ID, [DEVBOX]);
  const host = {
    pluginId: PLUGIN_ID,
    registerCloudProvider: vi.fn((descriptor: { id: string }, impl: CloudProviderImpl) =>
      Promise.resolve(bindPluginCloudProvider(PLUGIN_ID, descriptor.id, impl))
    ),
  };
  const workerHost = new FakeWorkerHost();
  new PluginDevWorkerMainBridge({
    pluginId: PLUGIN_ID,
    host: host as any,
    workerHost: workerHost as any,
    getCapabilities: () => [],
    clearPriorRegistrations: vi.fn(),
    onActivationResult: vi.fn(),
  })
    .waitForActivation()
    .catch(() => {});
  const proxy = new PluginDevWorkerHostProxy(
    PLUGIN_ID,
    (msg) => workerHost.emit("worker-message", msg),
    IDENTITY
  );
  workerHost.proxy = proxy;

  const plugin = sampleDevboxPlugin();
  await plugin.activate(proxy.host);
  await flush();

  const runtime: PluginCloudProviderRuntime = {
    activate: vi.fn(async () => {}),
    isActivated: () => true,
    unavailableReason: () => "unused",
  };
  const provider = new PluginCloudProvider(
    { pluginId: PLUGIN_ID, providerId: PROVIDER_ID, contribution: DEVBOX },
    { runtime: () => runtime, binding: pluginCloudProviderBinding }
  );
  return { plugin, provider, workerHost, host };
}

const credentials = (signal?: AbortSignal) => ({
  values: { token: "good-token" },
  scopeId: "me",
  apiUrl: "https://api.devbox.example",
  ...(signal ? { signal } : {}),
});

afterEach(() => clearPluginCloudProviders());

describe("a plugin's cloud provider over the worker port", () => {
  it("checks, creates, starts, stops and deletes a machine on the plugin's backend", async () => {
    const { plugin, provider, host } = await connected();
    expect(host.registerCloudProvider).toHaveBeenCalledTimes(1);

    await expect(
      provider.checkCredentials({ token: "good-token" }, "https://api.devbox.example")
    ).resolves.toEqual({
      identity: "dev@example.com",
      scopes: [{ scope: { kind: "personal", id: "me", name: "Personal" }, active: true }],
    });
    // The impl got a signal of its own, built on its side of the port.
    expect(plugin.seen[0]!.signal).toBeInstanceOf(AbortSignal);

    const catalog = await provider.catalog(credentials());
    expect(catalog.machineTypes.map((type) => type.id)).toEqual(["small"]);

    const request = {
      name: "build",
      machineType: "small",
      lifetimeSeconds: null,
      provisioning: {},
      labels: { "daintree-binding": "cb_1" },
      idempotencyKey: "key-1",
      publicKey: "ssh-ed25519 AAAAC3Nza test",
    };
    const created = await provider.create(credentials(), request);
    expect(created).toMatchObject({ resourceId: "dbx-1", machine: "starting" });
    // A retried create with the same key finds the same machine.
    await expect(provider.create(credentials(), request)).resolves.toMatchObject({
      resourceId: "dbx-1",
    });
    expect(plugin.machines.size).toBe(1);
    // Only the account's own set and scope crossed, without the caller's signal.
    expect(plugin.seen.at(-1)!.credentials).toMatchObject({
      values: { token: "good-token" },
      scopeId: "me",
      apiUrl: "https://api.devbox.example",
    });

    await expect(provider.start(credentials(), "dbx-1", {})).resolves.toMatchObject({
      machine: "running",
    });
    await expect(provider.sshAccess!(credentials(), "dbx-1")).resolves.toEqual({
      user: "dev",
      endpoint: { host: "10.0.0.5", port: 22 },
      hostKey: null,
    });
    await expect(
      provider.list(credentials(), { label: "daintree-binding=cb_1" })
    ).resolves.toHaveLength(1);
    await expect(provider.stop(credentials(), "dbx-1")).resolves.toMatchObject({
      machine: "stopped",
    });
    expect(plugin.machines.get("dbx-1")?.machine).toBe("stopped");

    await provider.delete(credentials(), "dbx-1");
    expect(plugin.machines.size).toBe(0);
    const gone = await provider.inspect(credentials(), "dbx-1").catch((e: unknown) => e);
    expect(provider.describeError(gone)).toMatchObject({
      code: "not-found",
      message: "No machine dbx-1",
    });
  });

  it("carries the provider's own refusal across with its code", async () => {
    const { provider } = await connected();
    const error = await provider
      .checkCredentials({ token: "wrong" }, "https://api.devbox.example")
      .catch((e: unknown) => e);
    expect(provider.describeError(error)).toMatchObject({
      code: "credential-invalid",
      message: "That token was refused.",
    });
  });

  it("surfaces a crashed worker as an unreachable provider on the call, and drops its binding", async () => {
    const { plugin, provider, workerHost } = await connected();
    plugin.impl.stop = () => new Promise(() => {});
    const pending = provider.stop(credentials(), "dbx-1").catch((e: unknown) => e);
    await flush();
    workerHost.emit("exit", 1, false);
    const error = await pending;
    expect(provider.describeError(error)).toMatchObject({
      code: "provider-unreachable",
      message: "Couldn't reach Devbox: the acme.devboxes plugin stopped before it answered.",
    });
    expect(pluginCloudProviderBinding(PROVIDER_ID)).toBeUndefined();

    // Until a replacement registers it again, a call says so rather than hanging.
    const next = await provider.validate(credentials()).catch((e: unknown) => e);
    expect(provider.describeError(next).code).toBe("provider-unreachable");
  });

  it("aborts the plugin's signal when the caller gives up, and drops the late answer", async () => {
    const { plugin, provider, workerHost } = await connected();
    let workerSignal: AbortSignal | undefined;
    let answer: (() => void) | undefined;
    plugin.impl.rename = (callCredentials) => {
      workerSignal = callCredentials.signal;
      return new Promise<void>((resolve) => {
        answer = resolve;
      });
    };
    const controller = new AbortController();
    const pending = provider.rename(credentials(controller.signal), "dbx-1", "renamed");
    await flush();
    controller.abort(new Error("closed"));
    await expect(pending).rejects.toThrow("closed");
    expect(workerSignal?.aborted).toBe(true);
    expect(workerHost.sent).toContainEqual(expect.objectContaining({ type: "invoke-cancel" }));

    const posted: any[] = [];
    workerHost.on("worker-message", (msg) => posted.push(msg));
    answer?.();
    await flush();
    expect(posted.filter((msg) => msg.type === "invoke-result")).toEqual([]);
  });

  it("refuses a provider whose impl lacks what its declaration needs, failing the registration", async () => {
    publishPluginCloudProviders(PLUGIN_ID, [DEVBOX]);
    const host = {
      pluginId: PLUGIN_ID,
      registerCloudProvider: vi.fn((descriptor: { id: string }, impl: CloudProviderImpl) =>
        Promise.resolve(bindPluginCloudProvider(PLUGIN_ID, descriptor.id, impl))
      ),
    };
    const workerHost = new FakeWorkerHost();
    new PluginDevWorkerMainBridge({
      pluginId: PLUGIN_ID,
      host: host as any,
      workerHost: workerHost as any,
      getCapabilities: () => [],
      clearPriorRegistrations: vi.fn(),
      onActivationResult: vi.fn(),
    })
      .waitForActivation()
      .catch(() => {});
    const proxy = new PluginDevWorkerHostProxy(
      PLUGIN_ID,
      (msg) => workerHost.emit("worker-message", msg),
      IDENTITY
    );
    workerHost.proxy = proxy;
    const { impl } = sampleDevboxPlugin();
    const { sshAccess: _dropped, ...withoutSshAccess } = impl;
    await proxy.host.registerCloudProvider({ id: "devbox" }, withoutSshAccess as CloudProviderImpl);
    await flush();
    expect(pluginCloudProviderBinding(PROVIDER_ID)).toBeUndefined();
    expect(workerHost.sent).toContainEqual(
      expect.objectContaining({
        type: "register-error",
        registrationKey: "cloudProvider:devbox",
        error: expect.stringContaining("has no sshAccess"),
      })
    );
  });
});
