import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloudHostsSnapshot,
  CloudProviderCapabilities,
  CloudProviderInfo,
} from "../../../../shared/types/cloudHosts.js";
import type { HostConnection, HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { AppError } from "../../../utils/errorTypes.js";
import { BoatProvider } from "../boat/BoatProvider.js";
import { CloudAccountService } from "../CloudAccountService.js";
import { MemoryCloudCredentialVault } from "../CloudCredentialVault.js";
import { CloudHostLifecycle } from "../CloudHostLifecycle.js";
import { CloudHosts } from "../CloudHosts.js";
import {
  CloudHostStore,
  type CloudHostsValue,
  type StoredCloudBinding,
} from "../CloudHostStore.js";
import { CloudProviderRegistry } from "../CloudProviderRegistry.js";
import { CloudSshFiles } from "../CloudSshFiles.js";
import {
  canRenewLifetime,
  type CloudProvider,
  type OfferCreate,
  type ProviderResource,
} from "../provider.js";
import type { CommandRunner } from "../../client/commandRunner.js";

const PLUGIN_PROVIDER = "acme.clouds.ec2";
const NOW = Date.parse("2026-11-14T12:00:00Z");

function resource(overrides: Partial<ProviderResource> = {}): ProviderResource {
  return {
    resourceId: "i-0123456789",
    name: "build",
    machine: "running",
    rawState: "running",
    machineType: "default",
    vcpu: 4,
    memoryGB: 8,
    autoStopAt: new Date(NOW + 20 * 60_000).toISOString(),
    lifetimeSeconds: 7200,
    stoppedAt: null,
    createdAt: null,
    stop: null,
    lastSnapshotAt: null,
    dataExpired: false,
    snapshotsDisabled: false,
    labels: {},
    restricted: false,
    error: null,
    ...overrides,
  };
}

function fakeProvider(id: string, machine: () => ProviderResource): CloudProvider {
  const boat = new BoatProvider(() => {
    throw new Error("unused");
  });
  return {
    id,
    info: (platform) => ({ ...boat.info(platform), id, name: `Provider ${id}` }),
    describeError: (error) => boat.describeError(error),
    checkCredentials: vi.fn(async () => ({
      identity: "octocat",
      scopes: [
        { scope: { kind: "personal" as const, id: "personal", name: "Personal" }, active: true },
      ],
    })),
    validate: vi.fn(async () => ({ identity: "octocat" })),
    catalog: vi.fn(async () => ({
      machineTypes: [],
      canStart: true,
      includedHoursRemaining: null,
      startsRemaining: null,
      savedSnapshotDayDollars: null,
    })),
    list: vi.fn(async () => [machine()]),
    inspect: vi.fn(async () => machine()),
    create: vi.fn(),
    start: vi.fn(async () => machine()),
    stop: vi.fn(async () => machine()),
    renewLifetime: vi.fn(async () => machine()),
    rename: vi.fn(),
    delete: vi.fn(),
    authorizeSsh: vi.fn(),
  } as CloudProvider;
}

describe("CloudProviderRegistry", () => {
  it("registers a plugin's provider under an id nobody knew at build time", () => {
    const registry = new CloudProviderRegistry();
    const provider = fakeProvider(PLUGIN_PROVIDER, () => resource());
    registry.register(provider, {
      owner: { kind: "plugin", pluginId: "acme.clouds" },
      apiUrl: "https://api.acme.test",
    });
    expect(registry.get(PLUGIN_PROVIDER)).toBe(provider);
    expect(registry.apiUrlFor(PLUGIN_PROVIDER)).toBe("https://api.acme.test");
    expect([...registry.values()]).toEqual([provider]);
  });

  it("keeps each owner inside its own namespace", () => {
    const registry = new CloudProviderRegistry();
    const plugin = { kind: "plugin" as const, pluginId: "acme.clouds" };
    // A plugin can't take a built-in's bare id, or another plugin's.
    expect(() =>
      registry.register(
        fakeProvider("boat", () => resource()),
        { owner: plugin, apiUrl: "" }
      )
    ).toThrow(/namespace/);
    expect(() =>
      registry.register(
        fakeProvider("other.clouds.ec2", () => resource()),
        {
          owner: plugin,
          apiUrl: "",
        }
      )
    ).toThrow(/namespace/);
    // Nor can a built-in take a plugin-shaped id.
    expect(() =>
      registry.register(
        fakeProvider(PLUGIN_PROVIDER, () => resource()),
        {
          owner: { kind: "built-in" },
          apiUrl: "",
        }
      )
    ).toThrow(/bare name/);
    expect(() =>
      registry.register(
        fakeProvider("Not An Id", () => resource()),
        {
          owner: { kind: "built-in" },
          apiUrl: "",
        }
      )
    ).toThrow(/Invalid/);
    expect([...registry.values()]).toEqual([]);
  });

  it("refuses a second provider under an id already held, and one that describes itself as another", () => {
    const registry = new CloudProviderRegistry();
    const owner = { kind: "built-in" as const };
    registry.register(new BoatProvider(() => ({}) as never), { owner, apiUrl: "a" });
    expect(() =>
      registry.register(new BoatProvider(() => ({}) as never), { owner, apiUrl: "b" })
    ).toThrow(/already registered/);
    expect(registry.apiUrlFor("boat")).toBe("a");
    const liar = fakeProvider("agent37", () => resource());
    liar.info = (platform) => ({ ...fakeProvider("boat", () => resource()).info(platform) });
    expect(() => registry.register(liar, { owner, apiUrl: "" })).toThrow(/describes itself/);
  });

  it("refuses a provider whose SSH declaration would trust a tunnel it doesn't run", () => {
    const registry = new CloudProviderRegistry();
    const owner = { kind: "plugin" as const, pluginId: "acme.clouds" };
    const declaring = (capabilities: Partial<CloudProviderCapabilities>) => {
      const provider = fakeProvider(PLUGIN_PROVIDER, () => resource());
      const base = provider.info.bind(provider);
      provider.info = (platform) => {
        const info = base(platform);
        return { ...info, capabilities: { ...info.capabilities, ...capabilities } };
      };
      return provider;
    };
    const tunnel = {
      command: "acme",
      args: ["tunnel", "%h"],
      installUrl: "https://acme.test/cli",
    };
    expect(() =>
      registry.register(declaring({ sshTrust: "provider-tunnel" }), { owner, apiUrl: "" })
    ).toThrow(/acme\.clouds\.ec2: .*tunnel/);
    expect(() =>
      registry.register(
        declaring({
          sshTrust: "provider-tunnel",
          transport: "provider-command",
          tunnel: { ...tunnel, command: "acme && curl evil" },
        }),
        { owner, apiUrl: "" }
      )
    ).toThrow(/bare executable name/);
    expect([...registry.values()]).toEqual([]);
    registry.register(
      declaring({ sshTrust: "provider-tunnel", transport: "provider-command", tunnel }),
      { owner, apiUrl: "" }
    );
    expect(registry.has(PLUGIN_PROVIDER)).toBe(true);
  });

  it("refuses a provider whose credential fields a form couldn't render or keep apart", () => {
    const registry = new CloudProviderRegistry();
    const owner = { kind: "plugin" as const, pluginId: "acme.clouds" };
    const declaring = (credentialFields: unknown) => {
      const provider = fakeProvider(PLUGIN_PROVIDER, () => resource());
      const info = provider.info;
      provider.info = (platform) => ({ ...info(platform), credentialFields }) as never;
      return provider;
    };
    const apiKey = {
      id: "apiKey",
      label: "API key",
      secret: true,
      input: "single-line",
      required: true,
      help: null,
    };
    for (const [fields, problem] of [
      [[], /no credential fields/],
      [[apiKey, { ...apiKey }], /twice/],
      [[{ ...apiKey, id: "__proto__" }], /invalid id/],
      [[{ ...apiKey, id: "constructor", required: false }], /invalid id/],
      [[{ ...apiKey, id: "toString" }], /invalid id/],
      [[{ ...apiKey, input: "dropdown" }], /unknown input/],
      [[{ ...apiKey, label: " " }], /without a label/],
      [[{ ...apiKey, secret: "yes" }], /secret and required/],
    ] as const) {
      expect(() => registry.register(declaring(fields), { owner, apiUrl: "" })).toThrow(problem);
    }
    expect([...registry.values()]).toEqual([]);
    registry.register(
      declaring([
        { ...apiKey, id: "keyFile", input: "key-file" },
        { ...apiKey, id: "project", secret: false },
      ]),
      { owner, apiUrl: "" }
    );
    expect(registry.has(PLUGIN_PROVIDER)).toBe(true);
  });

  it("refuses a provider that says its lifetime renews but can't renew it", () => {
    const registry = new CloudProviderRegistry();
    const owner = { kind: "plugin" as const, pluginId: "acme.clouds" };
    const broken = fakeProvider(PLUGIN_PROVIDER, () => resource());
    delete broken.renewLifetime;
    expect(() => registry.register(broken, { owner, apiUrl: "" })).toThrow(/renewable lifetime/);
    // One whose machines have no lifetime needs no renewal.
    const plain = fakeProvider(PLUGIN_PROVIDER, () => resource());
    const info = plain.info;
    plain.info = (platform) => {
      const described = info(platform);
      return {
        ...described,
        capabilities: { ...described.capabilities, lifetime: { kind: "none" } },
      };
    };
    delete plain.renewLifetime;
    registry.register(plain, { owner, apiUrl: "" });
    expect(registry.get(PLUGIN_PROVIDER)).toBe(plain);
  });

  it("refuses a provider without the SSH method its key timing needs, and changes nothing", () => {
    const registry = new CloudProviderRegistry();
    const owner = { kind: "plugin" as const, pluginId: "acme.clouds" };
    const changes = vi.fn();
    registry.onChange(changes);
    const timed = (sshKey: string) => {
      const provider = fakeProvider(PLUGIN_PROVIDER, () => resource());
      const info = provider.info;
      provider.info = (platform) => {
        const described = info(platform);
        const { capabilities } = described;
        return {
          ...described,
          capabilities: {
            ...capabilities,
            provisioning: {
              ...capabilities.provisioning,
              sshKey: sshKey as "at-create" | "after-create",
            },
          },
        };
      };
      return provider;
    };

    // Taking the key at create needs a way to read access; authorizing it after needs authorizeSsh.
    expect(() => registry.register(timed("at-create"), { owner, apiUrl: "" })).toThrow(/sshAccess/);
    const onlyAccess = timed("after-create");
    delete onlyAccess.authorizeSsh;
    onlyAccess.sshAccess = vi.fn();
    expect(() => registry.register(onlyAccess, { owner, apiUrl: "" })).toThrow(/authorizeSsh/);
    const notCallable = timed("at-create");
    (notCallable as { sshAccess?: unknown }).sshAccess = {};
    expect(() => registry.register(notCallable, { owner, apiUrl: "" })).toThrow(/sshAccess/);
    expect(() => registry.register(timed("on-boot"), { owner, apiUrl: "" })).toThrow(
      /unknown SSH key timing/
    );
    expect([...registry.values()]).toEqual([]);
    expect(changes).not.toHaveBeenCalled();

    // The method its timing needs is enough on its own.
    const atCreate = timed("at-create");
    delete atCreate.authorizeSsh;
    atCreate.sshAccess = vi.fn();
    registry.register(atCreate, { owner, apiUrl: "" });
    expect(registry.get(PLUGIN_PROVIDER)).toBe(atCreate);
  });

  describe("stop and create declarations", () => {
    const builtIn = { kind: "built-in" as const };
    const declaring = (
      id: string,
      declared: Partial<Pick<CloudProviderInfo, "stopMode" | "createMode">>,
      capabilities: Partial<CloudProviderCapabilities> = {}
    ) => {
      const provider = fakeProvider(id, () => resource());
      const info = provider.info;
      provider.info = (platform) => {
        const described = info(platform);
        return {
          ...described,
          ...declared,
          capabilities: { ...described.capabilities, ...capabilities },
        };
      };
      return provider;
    };
    /** Delete-only as a provider whose machines are only ever deleted has to be. */
    const deleteOnly = (id = "akash") => {
      const provider = declaring(id, { stopMode: "delete-only" }, { lifetime: { kind: "none" } });
      delete provider.start;
      delete provider.stop;
      delete provider.renewLifetime;
      return provider;
    };
    const offerCreate = (): OfferCreate => ({
      placeOrder: vi.fn(),
      findOrders: vi.fn(),
      listOffers: vi.fn(),
      leaseOffer: vi.fn(),
      closeOrder: vi.fn(),
    });
    const offerBased = (id = "akash") => {
      const provider = declaring(id, { createMode: "offers" });
      (provider as { offerCreate?: OfferCreate }).offerCreate = offerCreate();
      return provider;
    };
    const refuses = (provider: CloudProvider, problem: RegExp) => {
      const registry = new CloudProviderRegistry();
      const changes = vi.fn();
      registry.onChange(changes);
      expect(() => registry.register(provider, { owner: builtIn, apiUrl: "" })).toThrow(problem);
      expect([...registry.values()]).toEqual([]);
      expect(changes).not.toHaveBeenCalled();
    };
    const accepts = (provider: CloudProvider) => {
      const registry = new CloudProviderRegistry();
      registry.register(provider, { owner: builtIn, apiUrl: "" });
      expect(registry.get(provider.id)).toBe(provider);
    };

    it("needs a start and a stop from a provider that declares no stop mode", () => {
      for (const missing of ["start", "stop"] as const) {
        const provider = fakeProvider("akash", () => resource());
        delete provider[missing];
        refuses(provider, new RegExp(`stops and starts machines but has no ${missing}$`));
        const notCallable = fakeProvider("akash", () => resource());
        (notCallable as unknown as Record<string, unknown>)[missing] = {};
        refuses(notCallable, new RegExp(`has no ${missing}$`));
      }
      const neither = fakeProvider("akash", () => resource());
      delete neither.start;
      delete neither.stop;
      refuses(neither, /has no start or stop/);
      accepts(fakeProvider("akash", () => resource()));
    });

    it("takes a provider whose machines are only deleted without a start or a stop", () => {
      accepts(deleteOnly());
    });

    it("refuses a delete-only provider that keeps a way to stop, sleep or move a deadline", () => {
      const members = {
        start: vi.fn(),
        stop: vi.fn(),
        renewLifetime: vi.fn(),
        machineKeys: { issue: vi.fn(), revoke: vi.fn(), findByName: vi.fn() },
        checkGuestPowerOff: vi.fn(),
        sleepIdle: vi.fn(),
        setIdleSleep: vi.fn(),
        keepAwakeUrl: vi.fn(),
      };
      for (const [member, value] of Object.entries(members)) {
        const provider = deleteOnly();
        (provider as unknown as Record<string, unknown>)[member] = value;
        refuses(provider, new RegExp(`has no stop but has ${member}$`));
      }
    });

    it("refuses a delete-only provider that can't delete, or whose machines would stop by themselves", () => {
      for (const deletion of [false, "true"]) {
        const undeletable = deleteOnly();
        const info = undeletable.info;
        undeletable.info = (platform) => {
          const described = info(platform);
          const capabilities = { ...described.capabilities, deletion: deletion as boolean };
          return { ...described, capabilities };
        };
        refuses(undeletable, /can't delete, so its machines could never end/);
      }
      for (const remove of [undefined, "later"]) {
        const noDelete = deleteOnly();
        if (remove === undefined) delete (noDelete as { delete?: unknown }).delete;
        else (noDelete as unknown as Record<string, unknown>).delete = remove;
        refuses(noDelete, /can't delete, so its machines could never end/);
      }
      for (const lifetime of [
        { kind: "fixed-at-create", canChangeWhileStopped: false },
        { kind: "idle-sleep", idleSeconds: 600 },
      ] as const) {
        const provider = deleteOnly();
        const described = provider.info;
        provider.info = (platform) => {
          const base = described(platform);
          return { ...base, capabilities: { ...base.capabilities, lifetime } };
        };
        refuses(provider, new RegExp(`has no stop but declares a "${lifetime.kind}" lifetime`));
      }
    });

    it("refuses a stop mode it doesn't know", () => {
      const provider = declaring("akash", { stopMode: "never" as never });
      refuses(provider, /unknown stop mode "never"/);
    });

    it("needs a create from a provider that declares no create mode, and no offer create", () => {
      const noCreate = fakeProvider("akash", () => resource());
      delete (noCreate as { create?: unknown }).create;
      refuses(noCreate, /has no create$/);
      const notCallable = fakeProvider("akash", () => resource());
      (notCallable as unknown as Record<string, unknown>).create = {};
      refuses(notCallable, /has no create$/);
      for (const group of [offerCreate(), null]) {
        const undeclared = fakeProvider("akash", () => resource());
        (undeclared as unknown as Record<string, unknown>).offerCreate = group;
        refuses(undeclared, /has an offer create but declares no createMode/);
      }
      const brokenPrepare = fakeProvider("akash", () => resource());
      (brokenPrepare as unknown as Record<string, unknown>).prepareCreate = "soon";
      refuses(brokenPrepare, /prepareCreate that can't be called/);
      const prepared = fakeProvider("akash", () => resource());
      prepared.prepareCreate = vi.fn();
      accepts(prepared);
    });

    it("takes a provider whose create goes through offers with its whole offer create", () => {
      accepts(offerBased());
    });

    it("refuses an offer-based provider missing any part of its offer create", () => {
      const missingGroup = declaring("akash", { createMode: "offers" });
      refuses(missingGroup, /creates through offers but has no offerCreate/);
      const nullGroup = declaring("akash", { createMode: "offers" });
      (nullGroup as unknown as Record<string, unknown>).offerCreate = null;
      refuses(nullGroup, /creates through offers but has no offerCreate/);
      for (const method of Object.keys(offerCreate()) as (keyof OfferCreate)[]) {
        for (const replacement of [undefined, "later"]) {
          const provider = offerBased();
          const group = provider.offerCreate as unknown as Record<string, unknown>;
          if (replacement === undefined) delete group[method];
          else group[method] = replacement;
          refuses(provider, new RegExp(`its offerCreate has no ${method}$`));
        }
      }
      const noCreate = offerBased();
      delete (noCreate as { create?: unknown }).create;
      refuses(noCreate, /has no create$/);
    });

    it("refuses an offer-based provider that readies a send, or a create mode it doesn't know", () => {
      const prepared = offerBased();
      prepared.prepareCreate = vi.fn();
      refuses(prepared, /creates through offers but has prepareCreate/);
      refuses(declaring("akash", { createMode: "auction" as never }), /unknown create mode/);
    });

    it("takes both declarations together, from a built-in only", () => {
      const both = () => {
        const provider = deleteOnly();
        const info = provider.info;
        provider.info = (platform) => ({ ...info(platform), createMode: "offers" });
        (provider as { offerCreate?: OfferCreate }).offerCreate = offerCreate();
        return provider;
      };
      accepts(both());

      const plugin = { kind: "plugin" as const, pluginId: "acme.clouds" };
      for (const provider of [deleteOnly(PLUGIN_PROVIDER), offerBased(PLUGIN_PROVIDER)]) {
        const registry = new CloudProviderRegistry();
        expect(() => registry.register(provider, { owner: plugin, apiUrl: "" })).toThrow(
          /only a built-in may/
        );
        expect(registry.has(PLUGIN_PROVIDER)).toBe(false);
      }
    });

    it("leaves a provider that declares neither as it registers today", () => {
      const provider = fakeProvider("akash", () => resource());
      expect(provider.info("linux")).not.toHaveProperty("stopMode");
      expect(provider.info("linux")).not.toHaveProperty("createMode");
      accepts(provider);
      const plain = new BoatProvider(() => ({}) as never);
      accepts(plain);
    });

    it("renews a lifetime only for a provider that can also stop and start the machine", () => {
      expect(canRenewLifetime(fakeProvider("akash", () => resource()))).toBe(true);
      for (const missing of ["start", "stop", "renewLifetime"] as const) {
        const provider = fakeProvider("akash", () => resource());
        delete provider[missing];
        expect(canRenewLifetime(provider)).toBe(false);
      }
    });
  });

  it("lets an old registration's remover leave a newer one in place", () => {
    const registry = new CloudProviderRegistry();
    const owner = { kind: "plugin" as const, pluginId: "acme.clouds" };
    const changes = vi.fn();
    const stopWatching = registry.onChange(changes);
    const first = registry.register(
      fakeProvider(PLUGIN_PROVIDER, () => resource()),
      {
        owner,
        apiUrl: "one",
      }
    );
    first();
    expect(registry.get(PLUGIN_PROVIDER)).toBeUndefined();
    expect(registry.apiUrlFor(PLUGIN_PROVIDER)).toBeNull();
    const again = fakeProvider(PLUGIN_PROVIDER, () => resource());
    registry.register(again, { owner, apiUrl: "two" });
    first();
    expect(registry.get(PLUGIN_PROVIDER)).toBe(again);
    expect(changes).toHaveBeenCalledTimes(3);
    stopWatching();
    registry.register(new BoatProvider(() => ({}) as never), {
      owner: { kind: "built-in" },
      apiUrl: "",
    });
    expect(changes).toHaveBeenCalledTimes(3);
  });
});

describe("cloud accounts and hosts whose provider isn't registered", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-providers-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function setup(raw?: unknown) {
    const clock = { now: NOW };
    let backendValue: unknown = raw;
    const store = new CloudHostStore({
      get: () => backendValue,
      set: (_key: "cloudHosts", value: CloudHostsValue) => {
        backendValue = JSON.parse(JSON.stringify(value));
      },
    });
    const registry = new CloudProviderRegistry();
    const vault = new MemoryCloudCredentialVault();
    // What the plugin declares now, as its consent fingerprint.
    const declared = { fingerprint: "fp-1" };
    let consentGranted = () => {};
    const accounts = new CloudAccountService({
      store,
      vault,
      providers: registry,
      apiUrlFor: (id) => registry.apiUrlFor(id),
      platform: "darwin",
      now: () => clock.now,
      pluginConsent: (id) =>
        id === PLUGIN_PROVIDER && registry.get(id)
          ? {
              pluginId: "acme.clouds",
              pluginName: "Acme Clouds",
              fingerprint: declared.fingerprint,
              providerNames: ["EC2"],
            }
          : null,
      onConsentGranted: () => consentGranted(),
    });
    const hosts: HostDescriptor[] = [];
    const disconnect = vi.fn(async () => {});
    const files = new CloudSshFiles(path.join(root, "cloud"), (async () => ({
      code: 0,
      stdout: "",
      stderr: "",
      spawnError: null,
      timedOut: false,
    })) as unknown as CommandRunner);
    const lifecycle = new CloudHostLifecycle({
      store,
      accounts,
      files,
      clientDir: root,
      hosts: {
        add: (name: string, connection: HostConnection) => {
          const descriptor = { id: name, name, connection } as HostDescriptor;
          hosts.push(descriptor);
          return descriptor;
        },
        get: (id) => hosts.find((host) => host.id === id) ?? null,
        list: () => hosts,
        forget: async () => {},
        disconnect,
        onChange: () => () => {},
      },
      changed: () => {},
      sleep: async () => {},
      activity: () => ({ connected: true, busy: true, shown: true }),
      now: () => clock.now,
    });
    const emitted: CloudHostsSnapshot[] = [];
    const cloudHosts = new CloudHosts({ accounts, store, emit: (s) => emitted.push(s) });
    cloudHosts.attachLifecycle(lifecycle);
    registry.onChange(() => cloudHosts.providersChanged());
    consentGranted = () => cloudHosts.providersChanged();
    return {
      declared,
      store,
      registry,
      vault,
      accounts,
      lifecycle,
      cloudHosts,
      hosts,
      emitted,
      clock,
      disconnect,
    };
  }

  const pluginOwner = { kind: "plugin" as const, pluginId: "acme.clouds" };

  async function importedHost() {
    const env = await setup();
    let machine = resource();
    const provider = fakeProvider(PLUGIN_PROVIDER, () => machine);
    const unregister = env.registry.register(provider, {
      owner: pluginOwner,
      apiUrl: "https://api.acme.test",
    });
    // Seeded as connect keeps it: with the consent the person gave for it (#17352).
    const account = { id: "ca_acmeplugin" };
    env.store.putAccount(
      {
        id: account.id,
        providerId: PLUGIN_PROVIDER,
        displayName: "octocat",
        identity: "octocat",
        scope: { kind: "personal", id: "personal", name: "Personal" },
        apiUrl: "https://api.acme.test",
        keyHint: null,
        credentialRevision: "rev-1",
        addedAt: NOW,
        validation: { status: "valid", checkedAt: NOW },
        lastProvisioning: null,
        pluginProvider: null,
      },
      { pluginId: "acme.clouds", fingerprint: "fp-1", approvedAt: NOW }
    );
    await env.vault.put(account.id, { apiKey: "acme_live_x" });
    const { hostId } = await env.lifecycle.importMachine({
      accountId: account.id,
      resourceId: "i-0123456789",
      name: "build",
    });
    return {
      ...env,
      provider,
      unregister,
      account,
      hostId,
      setMachine: (next: ProviderResource) => (machine = next),
    };
  }

  it("lists them as unavailable, with what was last seen, and asks the provider nothing", async () => {
    const env = await importedHost();
    await env.accounts.catalog(env.account.id);
    expect(env.provider.catalog).toHaveBeenCalledTimes(1);
    env.unregister();
    expect(env.accounts.summaries()[0]).toMatchObject({
      id: env.account.id,
      providerId: PLUGIN_PROVIDER,
      providerUnavailable: expect.stringContaining("acme.clouds"),
      validation: { status: "valid" },
      hostCount: 1,
    });
    expect(env.lifecycle.statuses()[0]).toMatchObject({
      hostId: env.hostId,
      providerUnavailable: expect.stringContaining("acme.clouds"),
      machine: "running",
      resourceId: "i-0123456789",
    });
    const snapshot = env.cloudHosts.snapshot();
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.hosts).toHaveLength(1);

    vi.mocked(env.provider.inspect).mockClear();
    await env.lifecycle.renewDue();
    await (env.lifecycle as unknown as { pollDue(): Promise<void> }).pollDue();
    expect(env.provider.renewLifetime).not.toHaveBeenCalled();
    expect(env.provider.inspect).not.toHaveBeenCalled();

    // A catalog read while it was registered is no way around it.
    await expect(env.accounts.catalog(env.account.id)).rejects.toBeInstanceOf(AppError);
    expect(env.provider.catalog).toHaveBeenCalledTimes(1);
  });

  it("pauses them like a missing provider while its plugin isn't allowed, and resumes them once it is", async () => {
    const env = await importedHost();
    // An update that changes what the plugin declares: registered still, and no longer agreed to.
    env.declared.fingerprint = "fp-2";
    env.cloudHosts.providersChanged();
    expect(env.accounts.summaries()[0]!.providerUnavailable).toContain("Acme Clouds");
    expect(env.lifecycle.statuses()[0]!.providerUnavailable).toContain("Acme Clouds");
    // Listed, so the person can review it.
    expect(env.cloudHosts.snapshot().providers[0]!.plugin).toMatchObject({ granted: false });

    vi.mocked(env.provider.inspect).mockClear();
    await env.lifecycle.renewDue();
    await (env.lifecycle as unknown as { pollDue(): Promise<void> }).pollDue();
    expect(env.provider.renewLifetime).not.toHaveBeenCalled();
    expect(env.provider.inspect).not.toHaveBeenCalled();
    await expect(env.lifecycle.startMachine(env.hostId)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      userMessage: expect.stringContaining("Acme Clouds"),
    });
    expect(env.provider.start).not.toHaveBeenCalled();

    const resumed = vi.spyOn(env.lifecycle, "providersChanged");
    env.accounts.allowAccountProvider(env.account.id, "fp-2");
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(env.lifecycle.statuses()[0]!.providerUnavailable).toBeNull();
    await env.lifecycle.renewDue();
    expect(env.provider.renewLifetime).toHaveBeenCalledTimes(1);
  });

  it("refuses a person's start, stop or lifetime change before anything here changes", async () => {
    const env = await importedHost();
    const id = env.store.bindings()[0]!.id;
    const set = (change: Partial<StoredCloudBinding>) =>
      env.store.updateBinding(id, (current) => ({ ...current, ...change }));
    env.unregister();
    const refused = {
      code: "UNSUPPORTED",
      userMessage: expect.stringContaining("acme.clouds"),
    };

    set({ intent: "stop" });
    await expect(env.lifecycle.startMachine(env.hostId)).rejects.toMatchObject(refused);
    expect(env.store.binding(id)!.intent).toBe("stop");

    set({ intent: "run" });
    await expect(env.lifecycle.stopMachine(env.hostId)).rejects.toMatchObject(refused);
    expect(env.store.binding(id)!.intent).toBe("run");
    expect(env.disconnect).not.toHaveBeenCalled();

    // A stopped machine's lifetime is otherwise only kept here, with no provider call to refuse it.
    set({ observation: { ...env.store.binding(id)!.observation!, machine: "stopped" } });
    expect(env.store.binding(id)!.lifetimeSeconds).toBe(7200);
    await expect(env.lifecycle.setLifetime(env.hostId, null)).rejects.toMatchObject(refused);
    expect(env.store.binding(id)!.lifetimeSeconds).toBe(7200);
    expect(env.provider.start).not.toHaveBeenCalled();
    expect(env.provider.stop).not.toHaveBeenCalled();
  });

  it("drops a renewal whose provider was replaced while its key was read", async () => {
    const env = await importedHost();
    const replacement = fakeProvider(PLUGIN_PROVIDER, () => resource());
    const read = env.vault.get.bind(env.vault);
    vi.spyOn(env.vault, "get").mockImplementationOnce(async (accountId) => {
      env.unregister();
      env.registry.register(replacement, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
      return read(accountId);
    });
    await env.lifecycle.renewDue();
    expect(env.provider.renewLifetime).not.toHaveBeenCalled();
    expect(replacement.renewLifetime).not.toHaveBeenCalled();
    expect(env.store.bindings()[0]!.lastError).toBeNull();
  });

  it("drops a renewal's answer, or its failure, once its provider left or was replaced", async () => {
    for (const outcome of ["answer", "failure", "left"] as const) {
      const env = await importedHost();
      const before = env.lifecycle.statuses()[0]!.autoStopAt;
      const replacement = fakeProvider(PLUGIN_PROVIDER, () => resource());
      vi.mocked(env.provider.renewLifetime!).mockImplementationOnce(async () => {
        env.unregister();
        if (outcome !== "left") {
          env.registry.register(replacement, {
            owner: pluginOwner,
            apiUrl: "https://api.acme.test",
          });
        }
        if (outcome === "failure") throw new Error("down");
        return resource({ autoStopAt: new Date(NOW + 120 * 60_000).toISOString() });
      });
      await env.lifecycle.renewDue();
      expect(env.provider.renewLifetime).toHaveBeenCalledTimes(1);
      const status = env.lifecycle.statuses()[0]!;
      expect(status.autoStopAt).toBe(before);
      expect(status.keptRunningAt).toBeNull();
      expect(status.lastError).toBeNull();
    }
  });

  it("refuses a lifetime change whose provider was replaced while a renewal settled", async () => {
    const env = await importedHost();
    let release: () => void = () => {};
    vi.mocked(env.provider.renewLifetime!).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return resource();
    });
    const renewing = env.lifecycle.renewDue();
    await vi.waitFor(() => expect(env.provider.renewLifetime).toHaveBeenCalledTimes(1));
    // Seen stopping meanwhile: the change is only kept here, so nothing after the settle checks again.
    const id = env.store.bindings()[0]!.id;
    env.store.updateBinding(id, (current) => ({
      ...current,
      observation: { ...current.observation!, machine: "stopped" },
    }));
    const changing = env.lifecycle.setLifetime(env.hostId, 4);
    // A replacement that renews too would take the change; only the guard stops it.
    const replacement = fakeProvider(PLUGIN_PROVIDER, () => resource());
    env.unregister();
    env.registry.register(replacement, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
    release();
    await renewing;
    await expect(changing).rejects.toThrow(/changed while this was being saved/);
    expect(env.store.bindings()[0]!.lifetimeSeconds).toBe(7200);
    expect(env.provider.renewLifetime).toHaveBeenCalledTimes(1);
    expect(replacement.renewLifetime).not.toHaveBeenCalled();
  });

  it("sends no lifetime change through a provider replaced while its key was read", async () => {
    const env = await importedHost();
    const replacement = fakeProvider(PLUGIN_PROVIDER, () => resource());
    const read = env.vault.get.bind(env.vault);
    vi.spyOn(env.vault, "get").mockImplementationOnce(async (accountId) => {
      env.unregister();
      env.registry.register(replacement, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
      return read(accountId);
    });
    await expect(env.lifecycle.setLifetime(env.hostId, 4)).rejects.toThrow(
      /changed while this was being saved/
    );
    expect(env.provider.renewLifetime).not.toHaveBeenCalled();
    expect(replacement.renewLifetime).not.toHaveBeenCalled();
    expect(env.store.bindings()[0]!.lifetimeSeconds).toBe(7200);
  });

  it("keeps nothing of a lifetime change answered after its provider was replaced", async () => {
    const env = await importedHost();
    const before = env.lifecycle.statuses()[0]!.autoStopAt;
    const replacement = fakeProvider(PLUGIN_PROVIDER, () => resource());
    vi.mocked(env.provider.renewLifetime!).mockImplementationOnce(async () => {
      env.unregister();
      env.registry.register(replacement, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
      return resource({ autoStopAt: new Date(NOW + 240 * 60_000).toISOString() });
    });
    await expect(env.lifecycle.setLifetime(env.hostId, 4)).rejects.toThrow(
      /changed while this was being saved/
    );
    expect(env.store.bindings()[0]!.lifetimeSeconds).toBe(7200);
    expect(env.lifecycle.statuses()[0]!.autoStopAt).toBe(before);
  });

  it("reports a replaced provider's late failure as the change it is, not the account's", async () => {
    const env = await importedHost();
    vi.mocked(env.provider.renewLifetime!).mockImplementationOnce(async () => {
      env.unregister();
      env.registry.register(
        fakeProvider(PLUGIN_PROVIDER, () => resource()),
        {
          owner: pluginOwner,
          apiUrl: "https://api.acme.test",
        }
      );
      throw new Error("key revoked");
    });
    await expect(env.lifecycle.setLifetime(env.hostId, 4)).rejects.toThrow(
      /changed while this was being saved/
    );
    expect(env.store.bindings()[0]!.lifetimeSeconds).toBe(7200);
  });

  it("polls again as soon as its provider is back, not after the time it was gone", async () => {
    const env = await importedHost();
    const poll = () => (env.lifecycle as unknown as { pollDue(): Promise<void> }).pollDue();
    vi.mocked(env.provider.inspect).mockClear();
    env.unregister();
    env.clock.now += 10 * 60_000;
    await poll();
    expect(env.provider.inspect).not.toHaveBeenCalled();
    env.registry.register(env.provider, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
    await poll();
    expect(env.provider.inspect).toHaveBeenCalledTimes(1);
  });

  it("renews other machines past one whose provider left", async () => {
    const env = await importedHost();
    const boatMachine = resource({ resourceId: "bx_23456789" });
    const boat = fakeProvider("boat", () => boatMachine);
    env.registry.register(boat, { owner: { kind: "built-in" }, apiUrl: "https://boat.test" });
    const boatAccount = await env.accounts.addAccount({
      providerId: "boat",
      credentials: { apiKey: "boat_live_x" },
      scopeId: "personal",
    });
    await env.lifecycle.importMachine({
      accountId: boatAccount.id,
      resourceId: "bx_23456789",
      name: "boat",
    });
    env.unregister();
    await env.lifecycle.renewDue();
    expect(env.provider.renewLifetime).not.toHaveBeenCalled();
    expect(boat.renewLifetime).toHaveBeenCalledTimes(1);
  });

  it("comes back with no new connect when the provider registers again", async () => {
    const env = await importedHost();
    await Promise.resolve();
    env.emitted.length = 0;
    env.unregister();
    await Promise.resolve();
    expect(env.emitted).toHaveLength(1);
    expect(env.emitted[0]).toMatchObject({
      providers: [],
      accounts: [{ id: env.account.id, providerUnavailable: expect.any(String) }],
      hosts: [{ hostId: env.hostId, providerUnavailable: expect.any(String) }],
    });
    env.registry.register(env.provider, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
    await Promise.resolve();
    expect(env.emitted).toHaveLength(2);
    expect(env.emitted[1]).toMatchObject({
      providers: [{ id: PLUGIN_PROVIDER }],
      accounts: [{ id: env.account.id, providerUnavailable: null }],
      hosts: [{ hostId: env.hostId, providerUnavailable: null }],
    });
    await env.lifecycle.renewDue();
    expect(env.provider.renewLifetime).toHaveBeenCalledTimes(1);
  });

  it("keeps an account and host stored under a provider this build doesn't have, and lets the account go", async () => {
    const env = await setup({
      version: 1,
      accounts: [
        {
          id: "ca_abcdefgh",
          providerId: "agent37",
          displayName: "Agent 37",
          identity: "octocat",
          scope: { kind: "personal", id: "personal", name: "Personal" },
          apiUrl: "https://api.agent37.test",
          keyHint: "wxyz",
          addedAt: 1,
          validation: { status: "valid", checkedAt: 1 },
        },
        {
          id: "ca_ijklmnop",
          providerId: "agent37",
          displayName: "Spare",
          identity: null,
          scope: { kind: "personal", id: "personal", name: "Personal" },
          apiUrl: "https://api.agent37.test",
          keyHint: null,
          addedAt: 1,
          validation: { status: "unknown", checkedAt: null, detail: null },
        },
      ],
      bindings: [
        {
          id: "cb_abcdefgh12",
          hostId: "h_agent37",
          accountId: "ca_abcdefgh",
          providerId: "agent37",
          resourceId: "inst_1",
          ownership: "imported",
          creation: null,
          lifetimeSeconds: null,
          intent: null,
          observation: {
            machine: "stopped",
            rawState: "sleeping",
            observedAt: 5,
          },
          access: null,
          lastError: null,
          createdAt: 1,
        },
      ],
    });
    expect(env.store.accounts().map((account) => account.id)).toEqual([
      "ca_abcdefgh",
      "ca_ijklmnop",
    ]);
    expect(env.accounts.summaries()[0]).toMatchObject({
      providerId: "agent37",
      providerUnavailable: expect.stringContaining("agent37"),
      hostCount: 1,
    });
    expect(env.lifecycle.statuses()).toEqual([
      expect.objectContaining({
        hostId: "h_agent37",
        providerUnavailable: expect.stringContaining("agent37"),
        machine: "stopped",
        observedAt: 5,
      }),
    ]);
    // Removing the unbound account needs nothing from its provider.
    await env.vault.put("ca_ijklmnop", { apiKey: "agent37_key" });
    await env.accounts.removeAccount("ca_ijklmnop");
    expect(await env.vault.get("ca_ijklmnop")).toBeNull();
    expect(env.store.accounts().map((account) => account.id)).toEqual(["ca_abcdefgh"]);
    expect(env.store.bindings()).toHaveLength(1);
  });

  /** A create sent before a restart that never heard back, under the plugin's provider. */
  function pendingCreate() {
    return {
      version: 1,
      accounts: [
        {
          id: "ca_abcdefgh",
          providerId: PLUGIN_PROVIDER,
          displayName: "Acme",
          identity: "octocat",
          scope: { kind: "personal", id: "personal", name: "Personal" },
          apiUrl: "https://api.acme.test",
          keyHint: "wxyz",
          addedAt: 1,
          validation: { status: "valid", checkedAt: 1 },
        },
      ],
      bindings: [
        {
          id: "cb_abcdefgh12",
          hostId: "h_acme",
          accountId: "ca_abcdefgh",
          providerId: PLUGIN_PROVIDER,
          resourceId: null,
          ownership: "created-by-daintree",
          creation: {
            operationId: "op",
            idempotencyKey: "key",
            sentAt: 2,
            name: "build",
            machineType: "default",
          },
          lifetimeSeconds: 7200,
          intent: "run",
          observation: null,
          access: null,
          lastError: null,
          createdAt: 1,
        },
      ],
      // Connected with the person's consent to the plugin as it is declared (#17352).
      providerConsents: [{ pluginId: "acme.clouds", fingerprint: "fp-1", approvedAt: 1 }],
    };
  }

  async function pendingCreateEnv() {
    const env = await setup(pendingCreate());
    env.hosts.push({ id: "h_acme", name: "build" } as HostDescriptor);
    await env.vault.put("ca_abcdefgh", { apiKey: "acme_live_x" });
    return env;
  }

  it("looks for a create a restart left unanswered once its provider registers", async () => {
    const env = await pendingCreateEnv();
    const created = resource({
      labels: { "daintree-binding": "cb_abcdefgh12" },
      createdAt: new Date(2).toISOString(),
    });
    const provider = fakeProvider(PLUGIN_PROVIDER, () => created);
    env.lifecycle.start();
    try {
      await vi.waitFor(() => expect(env.store.binding("cb_abcdefgh12")).not.toBeNull());
      expect(provider.list).not.toHaveBeenCalled();
      env.registry.register(provider, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
      await vi.waitFor(() =>
        expect(env.store.binding("cb_abcdefgh12")?.resourceId).toBe("i-0123456789")
      );
      expect(env.store.binding("cb_abcdefgh12")?.creation).toBeNull();
    } finally {
      env.lifecycle.dispose();
    }
  });

  it("leaves a create a Retry finished while the provider was asked alone", async () => {
    const env = await pendingCreateEnv();
    const provider = fakeProvider(PLUGIN_PROVIDER, () => resource());
    let answer!: (found: ProviderResource[]) => void;
    vi.mocked(provider.list).mockImplementationOnce(
      () => new Promise<ProviderResource[]>((resolve) => (answer = resolve))
    );
    env.lifecycle.start();
    try {
      await vi.waitFor(() => expect(env.store.binding("cb_abcdefgh12")).not.toBeNull());
      env.registry.register(provider, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
      await vi.waitFor(() => expect(provider.list).toHaveBeenCalledTimes(1));
      // What a Retry leaves behind once its create is answered.
      env.store.updateBinding("cb_abcdefgh12", (current) => ({
        ...current,
        resourceId: "i-0123456789",
        creation: null,
      }));
      answer([]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(env.store.binding("cb_abcdefgh12")).toMatchObject({
        resourceId: "i-0123456789",
        lastError: null,
      });
    } finally {
      env.lifecycle.dispose();
    }
  });

  it("looks again when its provider left while it was being asked", async () => {
    const env = await pendingCreateEnv();
    const created = resource({
      labels: { "daintree-binding": "cb_abcdefgh12" },
      createdAt: new Date(2).toISOString(),
    });
    const provider = fakeProvider(PLUGIN_PROVIDER, () => created);
    let unregister = () => {};
    vi.mocked(provider.list).mockImplementationOnce(async () => {
      unregister();
      throw new Error("worker stopped");
    });
    env.lifecycle.start();
    try {
      await vi.waitFor(() => expect(env.store.binding("cb_abcdefgh12")).not.toBeNull());
      unregister = env.registry.register(provider, {
        owner: pluginOwner,
        apiUrl: "https://api.acme.test",
      });
      await vi.waitFor(() => expect(provider.list).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(env.store.binding("cb_abcdefgh12")?.resourceId).toBeNull();
      env.registry.register(provider, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
      await vi.waitFor(() =>
        expect(env.store.binding("cb_abcdefgh12")?.resourceId).toBe("i-0123456789")
      );
    } finally {
      env.lifecycle.dispose();
    }
  });

  it("looks again when its provider came back before the old lookup failed", async () => {
    const env = await pendingCreateEnv();
    const created = resource({
      labels: { "daintree-binding": "cb_abcdefgh12" },
      createdAt: new Date(2).toISOString(),
    });
    const provider = fakeProvider(PLUGIN_PROVIDER, () => created);
    let fail!: (error: Error) => void;
    vi.mocked(provider.list).mockImplementationOnce(
      () => new Promise<ProviderResource[]>((_resolve, reject) => (fail = reject))
    );
    env.lifecycle.start();
    try {
      await vi.waitFor(() => expect(env.store.binding("cb_abcdefgh12")).not.toBeNull());
      const unregister = env.registry.register(provider, {
        owner: pluginOwner,
        apiUrl: "https://api.acme.test",
      });
      await vi.waitFor(() => expect(provider.list).toHaveBeenCalledTimes(1));
      unregister();
      env.registry.register(provider, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
      fail(new Error("worker stopped"));
      await vi.waitFor(() =>
        expect(env.store.binding("cb_abcdefgh12")?.resourceId).toBe("i-0123456789")
      );
      expect(provider.list).toHaveBeenCalledTimes(2);
    } finally {
      env.lifecycle.dispose();
    }
  });
});
