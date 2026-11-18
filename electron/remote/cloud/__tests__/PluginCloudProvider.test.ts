import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CloudProviderContribution,
  CloudProviderImpl,
} from "../../../../shared/types/pluginCloudProvider.js";
import {
  PluginCloudProviderAnswerError,
  PluginCloudProviderTransportError,
} from "../../../services/plugin/pluginCloudProviderCalls.js";
import {
  bindPluginCloudProvider,
  clearPluginCloudProviders,
  listPluginCloudProviders,
  pluginCloudProviderBinding,
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

const CREATE = {
  name: "build",
  machineType: "t3.large",
  lifetimeSeconds: null,
  provisioning: { location: "us-east-1", image: null, network: null },
  labels: {},
  idempotencyKey: "k1",
  publicKey: "ssh-ed25519 AAAA test",
};

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
        stoppedStorageBilled: false,
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
    startFailure: () => null,
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

  it("sends nothing once the caller gave up while the plugin was still starting", async () => {
    const { provider, call, runtime } = harness();
    let finishActivation!: () => void;
    vi.mocked(runtime.activate).mockImplementation(
      () => new Promise<void>((resolve) => (finishActivation = resolve))
    );
    const controller = new AbortController();
    const pending = provider
      .create({ ...CREDENTIALS, signal: controller.signal }, CREATE)
      .catch((e: unknown) => e);
    await Promise.resolve();
    controller.abort(new Error("cancelled by the person"));
    expect(await pending).toEqual(new Error("cancelled by the person"));
    // The plugin finishes starting, with the provider bound, after the caller left.
    finishActivation();
    await new Promise((resolve) => setImmediate(resolve));
    expect(call).not.toHaveBeenCalled();
  });

  it("counts activation against the call's deadline", async () => {
    vi.useFakeTimers();
    const { provider, call, runtime } = harness({ timeoutMs: 30_000 });
    let finishActivation!: () => void;
    vi.mocked(runtime.activate).mockImplementation(
      () => new Promise<void>((resolve) => (finishActivation = resolve))
    );
    const pending = provider.create(CREDENTIALS, CREATE).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(provider.describeError(await pending).code).toBe("provider-unreachable");
    finishActivation();
    await vi.advanceTimersByTimeAsync(0);
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

    for (const ask of [
      () => provider.inspect(CREDENTIALS, "i-1"),
      () => provider.start(CREDENTIALS, "i-1", {}),
      () => provider.stop(CREDENTIALS, "i-1"),
    ]) {
      call.mockResolvedValueOnce(machine({ resourceId: "i-2" }));
      await expect(ask()).rejects.toThrow("the machine");
    }

    call.mockResolvedValueOnce(machine({ machine: "exploded" }));
    await expect(provider.inspect(CREDENTIALS, "i-1")).rejects.toThrow("the machine");

    call.mockResolvedValueOnce({
      identity: null,
      scopes: [{ scope: { kind: "team", id: "t" }, active: true }],
    });
    await expect(
      provider.checkCredentials({ accessKeyId: "x" }, CREDENTIALS.apiUrl)
    ).rejects.toThrow("its credential check");
  });

  it("fails an answer whose field is there but malformed, rather than reading it as none", async () => {
    const { provider, call } = harness();
    for (const malformed of [
      { autoStopAt: "soon" },
      { lifetimeSeconds: "2h" },
      { snapshotsDisabled: "true" },
      { restricted: undefined },
      { stop: { id: "s1", status: "halfway" } },
    ]) {
      call.mockResolvedValueOnce(machine(malformed));
      await expect(provider.inspect(CREDENTIALS, "i-1"), JSON.stringify(malformed)).rejects.toThrow(
        "the machine"
      );
    }
    // A failing save's long diagnostic is still its word, kept and cut short.
    call.mockResolvedValueOnce(
      machine({ stop: { id: "s1", status: "failing", error: "x".repeat(2000) } })
    );
    const failing = await provider.inspect(CREDENTIALS, "i-1");
    expect(failing.stop).toMatchObject({ status: "failing" });
    expect(failing.stop!.error).toHaveLength(512);
    // An identity left out, or one too long to keep, is never read as "nobody".
    call.mockResolvedValueOnce({});
    await expect(provider.validate(CREDENTIALS)).rejects.toThrow("its account check");
    call.mockResolvedValueOnce({ identity: "x".repeat(2000) });
    await expect(provider.validate(CREDENTIALS)).rejects.toThrow("its account check");
    call.mockResolvedValueOnce({ identity: null });
    await expect(provider.validate(CREDENTIALS)).resolves.toEqual({ identity: null });
  });

  it("keeps only the declared fields of an answer it can use, and always Daintree's own labels", async () => {
    const { provider, call } = harness();
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, "v"]));
    call.mockResolvedValueOnce([
      machine({
        labels: { ...many, bad: 2, constructor: "x", "daintree-binding": "cb_1" },
        extra: "dropped",
        autoStopAt: null,
      }),
    ]);
    const [listed] = await provider.list(CREDENTIALS, { label: "daintree-binding=cb_1" });
    expect(listed).not.toHaveProperty("extra");
    expect(Object.keys(listed!.labels)).toHaveLength(65);
    expect(listed!.labels["daintree-binding"]).toBe("cb_1");
    expect(listed!.labels).not.toHaveProperty("bad");
    expect(listed!.autoStopAt).toBeNull();
    expect(call).toHaveBeenLastCalledWith(
      "list",
      [CREDENTIALS, { label: "daintree-binding=cb_1" }],
      expect.any(AbortSignal)
    );

    call.mockResolvedValueOnce(null);
    await expect(provider.stop(CREDENTIALS, "i-1")).resolves.toBeNull();
  });

  it("reads a machine's sleep as the provider reports it, and nothing for one that doesn't say", async () => {
    const { provider, call } = harness();
    call.mockResolvedValueOnce(machine());
    const plain = await provider.inspect(CREDENTIALS, "i-1");
    expect(plain).not.toHaveProperty("asleep");
    expect(plain).not.toHaveProperty("idleSleep");

    call.mockResolvedValueOnce(
      machine({ machine: "stopped", asleep: true, idleSleep: { enabled: true, idleSeconds: 900 } })
    );
    await expect(provider.inspect(CREDENTIALS, "i-1")).resolves.toMatchObject({
      asleep: true,
      idleSleep: { enabled: true, idleSeconds: 900 },
    });

    for (const malformed of [
      { asleep: "yes" },
      { idleSleep: { idleSeconds: 900 } },
      { idleSleep: { enabled: true, idleSeconds: "15m" } },
    ]) {
      call.mockResolvedValueOnce(machine(malformed));
      await expect(provider.inspect(CREDENTIALS, "i-1"), JSON.stringify(malformed)).rejects.toThrow(
        "the machine"
      );
    }
  });

  it("takes every kind of billing scope a provider may offer", async () => {
    const { provider, call } = harness();
    const kinds = ["personal", "organization", "workspace", "project", "account"] as const;
    call.mockResolvedValueOnce({
      identity: "arn:aws:iam::1:user/ada",
      scopes: kinds.map((kind) => ({ scope: { kind, id: kind, name: kind }, active: true })),
    });
    const checked = await provider.checkCredentials({ accessKeyId: "x" }, CREDENTIALS.apiUrl);
    expect(checked.scopes.map((choice) => choice.scope.kind)).toEqual(kinds);
  });

  it("looks for machines where a create was sent, and replays a lost create as declared", async () => {
    const { provider, call } = harness();
    expect(provider.createReplay).toBeUndefined();
    call.mockResolvedValueOnce([]);
    await provider.list(CREDENTIALS, { label: "daintree-binding=cb_1", location: "eu-west-1" });
    expect(call).toHaveBeenLastCalledWith(
      "list",
      [CREDENTIALS, { label: "daintree-binding=cb_1", location: "eu-west-1" }],
      expect.any(AbortSignal)
    );

    const lookupOnly = new PluginCloudProvider(declaration({ createReplay: "lookup-only" }), {
      runtime: () => null,
      binding: () => undefined,
    });
    expect(lookupOnly.createReplay).toBe("lookup-only");
  });

  it("never hands one load's credentials to the impl a later load bound", async () => {
    const runtime = {
      activate: async () => {},
      isActivated: () => true,
      unavailableReason: () => "unused",
      startFailure: () => null,
    };
    const host = { runtime: () => runtime, binding: pluginCloudProviderBinding };
    const impl = (inspect: () => unknown) =>
      ({
        checkCredentials: vi.fn(),
        validate: vi.fn(),
        catalog: vi.fn(),
        list: vi.fn(),
        inspect: vi.fn(inspect),
        create: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn(),
        sshAccess: vi.fn(),
      }) as unknown as CloudProviderImpl;

    publishPluginCloudProviders("acme.clouds", [contribution()]);
    const [first] = listPluginCloudProviders();
    const old = new PluginCloudProvider(first!, host);
    // A reload moves the provider to another origin, and its new worker binds again.
    publishPluginCloudProviders("acme.clouds", [
      contribution({ apiUrl: "https://elsewhere.example.com" }),
    ]);
    const [second] = listPluginCloudProviders();
    const replacement = impl(() => machine());
    bindPluginCloudProvider("acme.clouds", "ec2", replacement);

    const error = await old.inspect(CREDENTIALS, "i-1").catch((e: unknown) => e);
    expect(old.describeError(error).code).toBe("provider-unreachable");
    expect(replacement.inspect).not.toHaveBeenCalled();
    const current = new PluginCloudProvider(second!, host);
    await expect(current.inspect(CREDENTIALS, "i-1")).resolves.toMatchObject({ resourceId: "i-1" });
    expect(replacement.inspect).toHaveBeenCalledTimes(1);
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

    // A reload that only adds a trailing slash names the same origin.
    publishPluginCloudProviders("acme.clouds", [
      contribution({ name: "EC2 v2", apiUrl: "https://ec2.example.com/" }),
    ]);
    const second = providers.get("acme.clouds.ec2");
    expect(second).not.toBe(first);
    expect(second?.info("darwin").name).toBe("EC2 v2");
    expect(providers.apiUrlFor("acme.clouds.ec2")).toBe("https://ec2.example.com");

    withdrawPluginCloudProviders("acme.clouds");
    expect(providers.has("acme.clouds.ec2")).toBe(false);
    // Each of those changed what is registered: none of them was only a reason.
    expect(statusChanged).not.toHaveBeenCalled();

    pluginCloudProviderStatusChanged();
    expect(statusChanged).toHaveBeenCalledTimes(1);

    publishPluginCloudProviders("acme.clouds", [contribution()]);
    expect(providers.has("acme.clouds.ec2")).toBe(true);
    watch.dispose();
    // Disposing takes what it registered with it, and it hears nothing after.
    expect(providers.has("acme.clouds.ec2")).toBe(false);
    publishPluginCloudProviders("acme.clouds", [contribution({ name: "EC2 v3" })]);
    expect(providers.has("acme.clouds.ec2")).toBe(false);
  });

  it("takes away a provider whose plugin fails to start, with why, and brings it back once it starts", () => {
    const providers = new CloudProviderRegistry();
    let failure: string | null = null;
    setPluginCloudProviderRuntime({
      activate: async () => {},
      isActivated: () => false,
      unavailableReason: () => "unused",
      startFailure: () => failure,
    });
    publishPluginCloudProviders("acme.clouds", [contribution()]);
    const watch = watchPluginCloudProviders({ providers, statusChanged: () => {} });
    expect(providers.has("acme.clouds.ec2")).toBe(true);

    failure = "activate() threw: no region";
    pluginCloudProviderStatusChanged();
    expect(providers.has("acme.clouds.ec2")).toBe(false);
    expect(watch.unavailableReason("acme.clouds.ec2")).toBe(
      "Its cloud provider comes from the acme.clouds plugin, which failed to start: activate() threw: no region"
    );

    failure = "crash loop";
    pluginCloudProviderStatusChanged();
    expect(watch.unavailableReason("acme.clouds.ec2")).toContain("failed to start: crash loop");

    failure = null;
    pluginCloudProviderStatusChanged();
    expect(providers.has("acme.clouds.ec2")).toBe(true);
    watch.dispose();
  });

  it("words a declaration the registry refuses, and otherwise defers to the plugin service", () => {
    const providers = new CloudProviderRegistry();
    setPluginCloudProviderRuntime({
      activate: async () => {},
      isActivated: () => false,
      unavailableReason: (pluginId) => `The ${pluginId} plugin is turned off.`,
      startFailure: () => null,
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
