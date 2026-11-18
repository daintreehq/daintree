import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudProviderContribution } from "../../../../shared/types/pluginCloudProvider.js";
import {
  PluginCloudProviderAnswerError,
  PluginCloudProviderTransportError,
} from "../../../services/plugin/pluginCloudProviderCalls.js";
import {
  clearPluginCloudProviders,
  publishPluginCloudProviders,
  pluginCloudProviderStatusChanged,
  setPluginCloudProviderRuntime,
  withdrawPluginCloudProviders,
  type PluginCloudProviderBinding,
  type PluginCloudProviderDeclaration,
  type PluginCloudProviderRuntime,
} from "../../../services/plugin/pluginCloudProviders.js";
import { CloudProviderRegistry } from "../CloudProviderRegistry.js";
import { PluginCloudProvider, type PluginCloudProviderHost } from "../PluginCloudProvider.js";
import { watchPluginCloudProviders } from "../pluginCloudProviderRegistrations.js";
import { canRenewLifetime } from "../provider.js";

const CREDENTIALS = {
  values: { accessKeyId: "AKIA" },
  scopeId: "personal",
  apiUrl: "https://ec2.example.com",
};

function contribution(
  overrides: Partial<CloudProviderContribution> = {}
): CloudProviderContribution {
  return {
    id: "ec2",
    name: "EC2",
    description: "Machines on your AWS account.",
    apiUrl: "https://ec2.example.com",
    apiKeyUrl: "https://console.example.com/keys",
    dashboardUrl: "https://console.example.com",
    docsUrl: "https://docs.example.com",
    credentialFields: [
      {
        id: "accessKeyId",
        label: "Access key ID",
        secret: false,
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
        stoppedComputeBilled: true,
      },
      typicalStartSeconds: 90,
      lifetime: { kind: "none" },
      sshTrust: "confirm-on-first-connect",
      transport: "direct",
      tunnel: null,
      provisioning: { location: "required", image: "none", network: "none", sshKey: "at-create" },
      deletion: true,
    },
    ...overrides,
  };
}

function declaration(
  overrides: Partial<CloudProviderContribution> = {}
): PluginCloudProviderDeclaration {
  return {
    pluginId: "acme.clouds",
    providerId: "acme.clouds.ec2",
    contribution: contribution(overrides),
  };
}

function machine(overrides: Record<string, unknown> = {}) {
  return {
    resourceId: "i-1",
    name: "build",
    machine: "running",
    rawState: "running",
    machineType: "t3.large",
    vcpu: 2,
    memoryGB: 8,
    autoStopAt: null,
    lifetimeSeconds: null,
    stoppedAt: null,
    createdAt: "2026-11-18T00:00:00Z",
    stop: null,
    lastSnapshotAt: null,
    dataExpired: false,
    snapshotsDisabled: false,
    labels: { "daintree-binding": "cb_1" },
    restricted: false,
    error: null,
    ...overrides,
  };
}

function harness(options: { activates?: boolean; bound?: boolean; timeoutMs?: number } = {}) {
  const call = vi.fn<PluginCloudProviderBinding["call"]>(async () => machine());
  const binding: PluginCloudProviderBinding = {
    methods: new Set([
      "checkCredentials",
      "validate",
      "catalog",
      "list",
      "inspect",
      "create",
      "start",
      "stop",
      "rename",
      "delete",
      "sshAccess",
    ]),
    call,
  };
  let activated = false;
  const runtime: PluginCloudProviderRuntime = {
    activate: vi.fn(async () => {
      activated = options.activates ?? true;
    }),
    isActivated: () => activated,
    unavailableReason: () => "unused",
  };
  const host: PluginCloudProviderHost = {
    runtime: () => runtime,
    binding: () => (options.bound === false ? undefined : binding),
    timeoutMs: options.timeoutMs,
    now: () => 42,
  };
  return { provider: new PluginCloudProvider(declaration(), host), call, runtime };
}

afterEach(() => {
  vi.useRealTimers();
  clearPluginCloudProviders();
});

describe("PluginCloudProvider", () => {
  it("describes itself from the manifest, with only the methods its declaration calls", () => {
    const { provider } = harness();
    const info = provider.info("darwin");
    expect(info).toMatchObject({
      id: "acme.clouds.ec2",
      name: "EC2",
      credentialFields: [{ id: "accessKeyId" }],
      unsupportedReason: null,
    });
    expect(provider.info("win32").unsupportedReason).not.toBeNull();
    expect(typeof provider.sshAccess).toBe("function");
    expect(provider.authorizeSsh).toBeUndefined();
    expect(canRenewLifetime(provider)).toBe(false);

    const renewing = new PluginCloudProvider(
      declaration({
        capabilities: {
          ...contribution().capabilities,
          lifetime: { kind: "renewable" },
          provisioning: {
            location: "none",
            image: "none",
            network: "none",
            sshKey: "after-create",
          },
        },
      }),
      { runtime: () => null, binding: () => undefined }
    );
    expect(canRenewLifetime(renewing)).toBe(true);
    expect(typeof renewing.authorizeSsh).toBe("function");
    expect(renewing.sshAccess).toBeUndefined();

    // What it hands out is a copy: nothing that reads it can change the manifest.
    info.credentialFields[0]!.label = "changed";
    expect(provider.info("darwin").credentialFields[0]!.label).toBe("Access key ID");
  });

  it("starts a plugin that isn't running, and sends the call without its signal", async () => {
    const { provider, call, runtime } = harness();
    const signal = new AbortController().signal;
    await expect(provider.stop({ ...CREDENTIALS, signal }, "i-1")).resolves.toMatchObject({
      resourceId: "i-1",
      machine: "running",
      createdAt: "2026-11-18T00:00:00.000Z",
    });
    expect(runtime.activate).toHaveBeenCalledWith("acme.clouds");
    expect(call).toHaveBeenCalledWith("stop", [CREDENTIALS, "i-1"], expect.any(AbortSignal));
  });

  it("reads a plugin that didn't start, or started without its provider, as unreachable", async () => {
    const notStarted = harness({ activates: false });
    const error = await notStarted.provider.validate(CREDENTIALS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluginCloudProviderTransportError);
    expect(notStarted.provider.describeError(error)).toEqual({
      code: "provider-unreachable",
      message:
        "Couldn't reach EC2: the acme.clouds plugin didn't start. Settings → Plugins shows why.",
      at: 42,
    });
    expect(notStarted.call).not.toHaveBeenCalled();

    const unbound = harness({ bound: false });
    const missing = await unbound.provider.validate(CREDENTIALS).catch((e: unknown) => e);
    expect(unbound.provider.describeError(missing)).toMatchObject({
      code: "provider-unreachable",
      message: expect.stringContaining("started without setting it up"),
    });
  });

  it("gives up on a plugin that doesn't answer, as unreachable, and aborts the call it was making", async () => {
    vi.useFakeTimers();
    const { provider, call } = harness({ timeoutMs: 30_000 });
    let seen: AbortSignal | undefined;
    call.mockImplementation((_method, _args, signal) => {
      seen = signal;
      return new Promise(() => {});
    });
    const pending = provider.inspect(CREDENTIALS, "i-1").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await pending;
    expect(provider.describeError(error)).toMatchObject({
      code: "provider-unreachable",
      message: "Couldn't reach EC2: the acme.clouds plugin didn't answer within 30 seconds.",
    });
    expect(seen?.aborted).toBe(true);
  });

  it("stops with the caller, and sends nothing once the caller gave up during activation", async () => {
    const { provider, call, runtime } = harness();
    const controller = new AbortController();
    vi.mocked(runtime.activate).mockImplementation(async () => {
      controller.abort(new Error("cancelled by the person"));
    });
    await expect(
      provider.create(
        { ...CREDENTIALS, signal: controller.signal },
        {
          name: "build",
          machineType: "t3.large",
          lifetimeSeconds: null,
          provisioning: { location: "us-east-1" },
          labels: {},
          idempotencyKey: "k1",
          publicKey: "ssh-ed25519 AAAA test",
        }
      )
    ).rejects.toThrow("cancelled by the person");
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps the plugin's named failure, and reads a worker that went away as unreachable", async () => {
    const { provider, call } = harness();
    call.mockRejectedValueOnce(new PluginCloudProviderAnswerError("capacity", "No capacity in eu"));
    const refused = await provider.start(CREDENTIALS, "i-1", {}).catch((e: unknown) => e);
    expect(provider.describeError(refused)).toMatchObject({
      code: "capacity",
      message: "No capacity in eu",
    });

    call.mockRejectedValueOnce(new Error('Plugin "acme.clouds" dev worker crashed (code 1)'));
    const crashed = await provider.start(CREDENTIALS, "i-1", {}).catch((e: unknown) => e);
    expect(provider.describeError(crashed)).toMatchObject({
      code: "provider-unreachable",
      message: "Couldn't reach EC2: the acme.clouds plugin stopped before it answered.",
    });
  });

  it("refuses an answer it can't use, and a machine that isn't the one asked about", async () => {
    const { provider, call } = harness();
    call.mockResolvedValueOnce({ machineTypes: "lots" });
    const catalog = await provider.catalog(CREDENTIALS).catch((e: unknown) => e);
    expect(provider.describeError(catalog)).toMatchObject({
      code: "failed",
      message: "EC2 sent back its catalog in a form Daintree can't read.",
    });

    call.mockResolvedValueOnce(machine({ resourceId: "i-2" }));
    const other = await provider.inspect(CREDENTIALS, "i-1").catch((e: unknown) => e);
    expect(provider.describeError(other).code).toBe("failed");

    call.mockResolvedValueOnce(machine({ machine: "exploded" }));
    await expect(provider.inspect(CREDENTIALS, "i-1")).rejects.toBeDefined();

    call.mockResolvedValueOnce({ scopes: [{ scope: { kind: "team", id: "t" }, active: true }] });
    await expect(
      provider.checkCredentials({ accessKeyId: "x" }, CREDENTIALS.apiUrl)
    ).rejects.toBeDefined();
  });

  it("keeps only the declared fields of an answer it can use", async () => {
    const { provider, call } = harness();
    call.mockResolvedValueOnce([
      machine({
        labels: { a: "1", bad: 2, constructor: "x" },
        extra: "dropped",
        autoStopAt: "soon",
      }),
    ]);
    const [listed] = await provider.list(CREDENTIALS, { label: "daintree-binding=cb_1" });
    expect(listed).not.toHaveProperty("extra");
    expect(listed!.labels).toEqual({ a: "1" });
    expect(listed!.autoStopAt).toBeNull();
    expect(call).toHaveBeenLastCalledWith(
      "list",
      [CREDENTIALS, { label: "daintree-binding=cb_1" }],
      expect.any(AbortSignal)
    );

    call.mockResolvedValueOnce(null);
    await expect(provider.stop(CREDENTIALS, "i-1")).resolves.toBeNull();
  });
});

describe("watchPluginCloudProviders", () => {
  it("registers what loaded plugins declare and follows them as they load, reload and unload", () => {
    const providers = new CloudProviderRegistry();
    const statusChanged = vi.fn();
    publishPluginCloudProviders("acme.clouds", [contribution()]);
    const watch = watchPluginCloudProviders({ providers, statusChanged });
    const first = providers.get("acme.clouds.ec2");
    expect(first).toBeInstanceOf(PluginCloudProvider);
    expect(providers.apiUrlFor("acme.clouds.ec2")).toBe("https://ec2.example.com");

    publishPluginCloudProviders("acme.clouds", [contribution({ name: "EC2 v2" })]);
    const second = providers.get("acme.clouds.ec2");
    expect(second).not.toBe(first);
    expect(second?.info("darwin").name).toBe("EC2 v2");

    withdrawPluginCloudProviders("acme.clouds");
    expect(providers.has("acme.clouds.ec2")).toBe(false);

    // Nothing to register or remove: only a reason may have changed.
    statusChanged.mockClear();
    pluginCloudProviderStatusChanged();
    expect(statusChanged).toHaveBeenCalledTimes(1);

    watch.dispose();
    publishPluginCloudProviders("acme.clouds", [contribution()]);
    expect(providers.has("acme.clouds.ec2")).toBe(false);
  });

  it("words a declaration the registry refuses, and otherwise defers to the plugin service", () => {
    const providers = new CloudProviderRegistry();
    setPluginCloudProviderRuntime({
      activate: async () => {},
      isActivated: () => false,
      unavailableReason: (pluginId) => `The ${pluginId} plugin is turned off.`,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    publishPluginCloudProviders("acme.clouds", [
      contribution({ credentialFields: [] }),
      contribution({ id: "gce" }),
    ]);
    const watch = watchPluginCloudProviders({ providers, statusChanged: () => {} });
    expect(providers.has("acme.clouds.ec2")).toBe(false);
    expect(providers.has("acme.clouds.gce")).toBe(true);
    expect(watch.unavailableReason("acme.clouds.ec2")).toContain("in a way Daintree can't use");
    expect(watch.unavailableReason("other.plugin.do")).toBe(
      "The other.plugin plugin is turned off."
    );
    expect(watch.unavailableReason("boat")).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    watch.dispose();
  });
});
