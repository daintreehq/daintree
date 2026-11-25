import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnection, HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import type {
  CloudCreateOffer,
  CloudHostError,
  CloudProviderId,
} from "../../../../shared/types/cloudHosts.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import type { CommandResult, CommandRunner } from "../../client/commandRunner.js";
import { BoatProvider } from "../boat/BoatProvider.js";
import { CloudAccountService } from "../CloudAccountService.js";
import { MemoryCloudCredentialVault } from "../CloudCredentialVault.js";
import { CloudHostLifecycle } from "../CloudHostLifecycle.js";
import {
  CloudHostStore,
  type CloudHostsStoreBackend,
  type StoredCreateOrder,
} from "../CloudHostStore.js";
import { CloudSshFiles } from "../CloudSshFiles.js";
import type { CloudProvider, ProviderCreateRequest, ProviderResource } from "../provider.js";

let root: string;
/** Every run a test started, ended with it even when an assertion stops the test first. */
const runs: CloudHostLifecycle[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-offer-create-"));
});

afterEach(async () => {
  for (const lifecycle of runs.splice(0)) lifecycle.dispose();
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});

const ok: CommandResult = { code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false };
const noCommands = (async () => ok) as unknown as CommandRunner;

/** The provider turning a request down: nothing was placed or leased. */
class Refusal extends Error {
  constructor(
    readonly code: CloudHostError["code"],
    message: string
  ) {
    super(message);
  }
}

/** A request whose answer never came back, whether or not the provider acted on it. */
const lost = () => new Error("socket hang up");

function machine(
  resourceId: string,
  labels: Record<string, string>,
  state: "running" | "starting" = "running"
): ProviderResource {
  return {
    resourceId,
    name: "build",
    machine: state,
    rawState: state === "running" ? "active" : "pending",
    machineType: "default",
    vcpu: 4,
    memoryGB: 16,
    autoStopAt: null,
    lifetimeSeconds: null,
    stoppedAt: null,
    createdAt: null,
    stop: null,
    lastSnapshotAt: null,
    dataExpired: false,
    snapshotsDisabled: false,
    labels,
    restricted: false,
    error: null,
  };
}

function offer(id: string, hourlyDollars = 0.5): CloudCreateOffer {
  return {
    id,
    hourlyDollars,
    bidder: { id: `bidder-${id}`, name: `Bidder ${id}`, region: "us-west" },
    choosable: true,
    reason: null,
  };
}

/**
 * How the next call of a kind goes. `lost`: the provider acts, the answer
 * never comes back. `unsent`: it never reaches the provider. `hang`: no
 * answer until the request is aborted; `hang-commit` acts first. `lost-twice`:
 * the one placement lands as two orders, and its answer is lost. `no-id`: the
 * order is placed, and the answer names none. `gone`: the offer was taken
 * back, as `not-found`. `requote`: the bidder quotes again just as the lease
 * arrives, after Daintree's last read.
 */
type Plan =
  | "ok"
  | "lost"
  | "lost-twice"
  | "no-id"
  | "unsent"
  | "refused"
  | "gone"
  | "requote"
  | "hang"
  | "hang-commit"
  | "fail";

interface FakeOrder {
  labels: Record<string, string>;
  idempotencyKey: string;
  state: "open" | "closed" | "leased";
  offers: CloudCreateOffer[];
  machine: ProviderResource | null;
}

/** An offer-based provider's account: orders, their offers, and the machines leased from them. */
class FakeOffers {
  readonly orders = new Map<string, FakeOrder>();
  readonly machines = new Map<string, ProviderResource>();
  readonly deleted: string[] = [];
  readonly plans: Record<"place" | "lease" | "close", Plan[]> = {
    place: [],
    lease: [],
    close: [],
  };
  /** Offers every new order gets. */
  offersOnPlace: CloudCreateOffer[] = [];
  /** What was stored when each placement and lease reached the provider. */
  readonly storedAtSend: Array<StoredCreateOrder[]> = [];
  storedNow: () => StoredCreateOrder[] = () => [];
  private next = 0;

  private plan(kind: "place" | "lease" | "close"): Plan {
    return this.plans[kind].shift() ?? "ok";
  }

  private hang<T>(signal: AbortSignal | undefined): Promise<T> {
    return new Promise<T>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }

  readonly placeOrder = vi.fn(
    async (credentials: { signal?: AbortSignal }, request: ProviderCreateRequest) => {
      this.storedAtSend.push(structuredClone(this.storedNow()));
      const plan = this.plan("place");
      if (plan === "refused") throw new Refusal("capacity", "No capacity for that size.");
      if (plan === "unsent") throw lost();
      if (plan === "hang") return this.hang<{ id: string }>(credentials.signal);
      const id = `dseq-${++this.next}`;
      this.orders.set(id, {
        labels: request.labels,
        idempotencyKey: request.idempotencyKey,
        state: "open",
        offers: [...this.offersOnPlace],
        machine: null,
      });
      if (plan === "lost-twice") this.commitLate(request);
      if (plan === "lost" || plan === "lost-twice") throw lost();
      if (plan === "hang-commit") return this.hang<{ id: string }>(credentials.signal);
      if (plan === "no-id") return { id: "" };
      return { id };
    }
  );

  /** An order placed outside any request this run saw: a lost one landing late. */
  commitLate(request: Pick<ProviderCreateRequest, "labels" | "idempotencyKey">): string {
    const id = `dseq-${++this.next}`;
    this.orders.set(id, {
      ...request,
      state: "open",
      offers: [...this.offersOnPlace],
      machine: null,
    });
    return id;
  }

  readonly findOrders = vi.fn(
    async (
      _credentials: unknown,
      match: Pick<ProviderCreateRequest, "labels" | "idempotencyKey">
    ) =>
      [...this.orders.entries()]
        .filter(
          ([, order]) =>
            order.state === "open" &&
            order.idempotencyKey === match.idempotencyKey &&
            Object.entries(match.labels).every(([key, value]) => order.labels[key] === value)
        )
        .map(([id]) => ({ id }))
  );

  readonly listOffers = vi.fn(async (_credentials: unknown, orderId: string) => {
    const order = this.orders.get(orderId);
    if (!order || order.state !== "open") throw new Refusal("not-found", "No such order.");
    return [...order.offers];
  });

  readonly leaseOffer = vi.fn(
    async (
      credentials: { signal?: AbortSignal },
      orderId: string,
      offerId: string,
      expected?: { hourlyDollars: number }
    ) => {
      this.storedAtSend.push(structuredClone(this.storedNow()));
      const plan = this.plan("lease");
      const order = this.orders.get(orderId);
      if (plan === "unsent") throw lost();
      if (plan === "hang") return this.hang<ProviderResource>(credentials.signal);
      if (!order || order.state !== "open" || !order.offers.some((o) => o.id === offerId)) {
        throw new Refusal("refused", "That offer has gone.");
      }
      if (plan === "refused" || plan === "gone") {
        order.offers = order.offers.filter((o) => o.id !== offerId);
        throw new Refusal(plan === "gone" ? "not-found" : "refused", "That offer has gone.");
      }
      if (plan === "requote") {
        order.offers = order.offers.map((o) => (o.id === offerId ? offer(o.id, 0.9) : o));
      }
      // The provider checks the rate the person saw as it accepts the bid.
      const quoted = order.offers.find((o) => o.id === offerId)!;
      if (expected && quoted.hourlyDollars !== expected.hourlyDollars) {
        throw new Refusal("refused", "That bid now quotes another rate.");
      }
      // It answers while the machine is still starting; reading it later finds it running.
      const leased = machine(`lease-${orderId}`, order.labels, "starting");
      order.state = "leased";
      order.machine = leased;
      this.machines.set(leased.resourceId, machine(leased.resourceId, order.labels));
      if (plan === "lost") throw lost();
      if (plan === "hang-commit") return this.hang<ProviderResource>(credentials.signal);
      return leased;
    }
  );

  readonly closeOrder = vi.fn(async (_credentials: unknown, orderId: string) => {
    if (this.plan("close") === "fail") throw lost();
    const order = this.orders.get(orderId);
    if (order?.state === "leased") return { kind: "leased" as const, resource: order.machine! };
    if (order) order.state = "closed";
    return { kind: "closed" as const };
  });

  /** A lease made where this device never saw it: the person's console, say. */
  leaseElsewhere(orderId: string): string {
    const order = this.orders.get(orderId)!;
    const leased = machine(`lease-${orderId}`, order.labels);
    order.state = "leased";
    order.machine = leased;
    this.machines.set(leased.resourceId, leased);
    return leased.resourceId;
  }

  openOrders(): string[] {
    return [...this.orders.entries()].filter(([, o]) => o.state === "open").map(([id]) => id);
  }
}

function offerProvider(api: FakeOffers): CloudProvider {
  const boat = new BoatProvider(() => {
    throw new Error("unused");
  });
  return {
    id: "boat",
    info: (platform) => {
      const info = boat.info(platform);
      return {
        ...info,
        createMode: "offers",
        stopMode: "delete-only",
        capabilities: { ...info.capabilities, deletion: true, lifetime: { kind: "none" } },
      };
    },
    describeError: (error) => ({
      code: error instanceof Refusal ? error.code : "failed",
      message: formatErrorMessage(error, "No answer"),
      at: Date.now(),
    }),
    checkCredentials: async () => ({
      identity: "octocat",
      scopes: [
        { scope: { kind: "personal" as const, id: "personal", name: "Personal" }, active: true },
      ],
    }),
    validate: async () => ({ identity: "octocat" }),
    catalog: async () => ({
      machineTypes: [
        {
          id: "default",
          label: "4 vCPU",
          vcpu: 4,
          memoryGB: 16,
          hourlyDollars: 0.5,
          available: true,
          reason: null,
        },
      ],
      canStart: true,
      includedHoursRemaining: null,
      startsRemaining: null,
      savedSnapshotDayDollars: null,
    }),
    list: async () => [...api.machines.values()],
    inspect: async (_credentials, resourceId) => {
      const found = api.machines.get(resourceId);
      if (!found) throw new Refusal("not-found", "No such machine.");
      return found;
    },
    create: vi.fn(async () => {
      throw new Refusal("unsupported", "Only a chosen offer leases a machine here.");
    }),
    rename: async () => {},
    delete: vi.fn(async (_credentials, resourceId: string) => {
      api.deleted.push(resourceId);
      api.machines.delete(resourceId);
    }),
    authorizeSsh: async () => ({
      user: "root",
      endpoint: { host: "203.0.113.9", port: 30022 },
      hostKey: null,
    }),
    offerCreate: {
      placeOrder: api.placeOrder,
      findOrders: api.findOrders,
      listOffers: api.listOffers,
      leaseOffer: api.leaseOffer,
      closeOrder: api.closeOrder,
    },
  };
}

/**
 * Daintree's cloud runtime over a fake offer-based provider. A crash ends a
 * run on the spot: nothing it would still write reaches the settings file,
 * and the next run starts from what was saved.
 */
async function offerCloud(hooks: { beforeRemoval?: () => Promise<void> } = {}) {
  const api = new FakeOffers();
  const provider = offerProvider(api);
  const saved = new Map<string, unknown>();
  const vault = new MemoryCloudCredentialVault();
  const hosts: HostDescriptor[] = [];
  const listeners = new Set<() => void>();
  const clock = { at: Date.now() };
  const files = new CloudSshFiles(path.join(root, "cloud"), noCommands);
  const build = () => {
    let alive = true;
    const store = new CloudHostStore({
      get: (key: string) => structuredClone(saved.get(key)),
      set: (key: string, value: unknown) => {
        if (alive) saved.set(key, JSON.parse(JSON.stringify(value)));
      },
    } as CloudHostsStoreBackend);
    const accounts = new CloudAccountService({
      store,
      vault,
      providers: new Map<CloudProviderId, CloudProvider>([["boat", provider]]),
      apiUrlFor: () => "https://boat.dev/api/v1",
      platform: "darwin",
      // As initClient wires it: the account's orders are closed before its credentials go.
      beforeAccountRemoved: async (accountId) => {
        await hooks.beforeRemoval?.();
        await lifecycle.settleAccountOrders(accountId);
      },
    });
    const lifecycle = new CloudHostLifecycle({
      store,
      accounts,
      files,
      clientDir: root,
      hosts: {
        add: (name: string, connection: HostConnection) => {
          const descriptor = { id: name, name, connection } as HostDescriptor;
          hosts.push(descriptor);
          for (const listener of listeners) listener();
          return descriptor;
        },
        get: (id) => hosts.find((host) => host.id === id) ?? null,
        list: () => hosts,
        forget: async (id) => {
          const index = hosts.findIndex((host) => host.id === id);
          if (index >= 0) hosts.splice(index, 1);
          for (const listener of listeners) listener();
        },
        disconnect: async () => {},
        onChange: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      changed: () => {},
      sleep: async () => {},
      now: () => clock.at,
    });
    runs.push(lifecycle);
    api.storedNow = () => store.createOrders();
    const kill = () => {
      alive = false;
      lifecycle.dispose();
    };
    return { store, accounts, lifecycle, kill };
  };
  let current = build();
  const account = await current.accounts.addAccount({
    providerId: "boat",
    credentials: { apiKey: "boat_live_x" },
    scopeId: "personal",
  });
  current.lifecycle.start();
  const env = {
    api,
    provider,
    hosts,
    clock,
    account,
    get store() {
      return current.store;
    },
    get accounts() {
      return current.accounts;
    },
    get lifecycle() {
      return current.lifecycle;
    },
    status: () => current.lifecycle.statuses()[0],
    saved,
    /** Takes the host out of the list, as Settings → Remove host does, keeping its machine. */
    removeHost: (hostId: string) => {
      const index = hosts.findIndex((host) => host.id === hostId);
      if (index >= 0) hosts.splice(index, 1);
      for (const listener of listeners) listener();
    },
    /** Ends this run where it stands and starts the next over what was saved. */
    crash: () => {
      current.kill();
      current = build();
      current.lifecycle.start();
    },
    create: async () => {
      const { hostId } = await current.lifecycle.create({
        accountId: account.id,
        name: "build",
        machineType: "default",
        lifetimeHours: null,
      });
      return hostId;
    },
    /** Waits until the host's create waits on a choice, with its offers read. */
    awaitChoice: async () => {
      await vi.waitFor(() => {
        const status = current.lifecycle.statuses()[0];
        expect(status?.operation).toBeNull();
        expect(typeof status?.pendingCreate?.offersReadAt).toBe("number");
      });
      return current.lifecycle.statuses()[0]!.pendingCreate!;
    },
    settled: async () => {
      await vi.waitFor(() => expect(current.lifecycle.statuses()[0]?.operation ?? null).toBeNull());
    },
  };
  return env;
}

describe("offer-based create (#18230)", () => {
  it("places the order, shows its offers as a choice, and reads them again while it waits", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a")];
    await env.create();
    const choice = await env.awaitChoice();
    expect(choice.kind).toBe("awaiting-offer");
    expect(env.api.openOrders()).toEqual([choice.order.id]);
    expect(choice.offers.map((o) => o.id)).toEqual(["a"]);
    expect(choice.waitingSince).toBe(env.clock.at);
    // The order was written down, with the key it carries, before it was placed.
    const [atSend] = env.api.storedAtSend;
    expect(atSend).toHaveLength(1);
    expect(atSend![0]).toMatchObject({ state: "placing", orderIds: null });
    expect(env.api.placeOrder.mock.calls[0]![1].idempotencyKey).toBe(atSend![0]!.idempotencyKey);
    expect(env.provider.create).not.toHaveBeenCalled();
    expect(env.status()?.resourceId).toBeNull();

    // A new bidder answers while the person looks.
    env.api.orders.get(choice.order.id)!.offers.push(offer("b", 0.4));
    env.clock.at += 15_000;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() =>
      expect(env.status()?.pendingCreate?.offers.map((o) => o.id)).toEqual(["a", "b"])
    );
    expect(env.status()?.pendingCreate?.offersReadAt).toBe(env.clock.at);
    expect(env.status()?.pendingCreate?.waitingSince).toBe(choice.waitingSince);
  });

  it("leases the chosen offer, binds its machine and carries on to running", async () => {
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a"), offer("b")];
    const hostId = await env.create();
    const choice = await env.awaitChoice();
    await env.lifecycle.chooseOffer(hostId, choice.order.id, "b", 0.5);
    // The lease was written down, naming that order and offer, before it was sent.
    expect(env.api.storedAtSend[1]![0]).toMatchObject({
      state: "leasing",
      orderIds: [choice.order.id],
      offerId: "b",
    });
    expect(env.api.leaseOffer).toHaveBeenCalledWith(expect.anything(), choice.order.id, "b", {
      hourlyDollars: 0.5,
    });
    await env.settled();
    const status = env.status()!;
    expect(status.resourceId).toBe(`lease-${choice.order.id}`);
    // The lease answered while it was starting: it runs because the create waited for it.
    expect(status.machine).toBe("running");
    expect(status.pendingCreate).toBeUndefined();
    expect(status.lastError).toBeNull();
    expect(env.store.createOrders()).toEqual([]);
    expect(env.api.leaseOffer).toHaveBeenCalledTimes(1);
  });

  it("refuses an offer that has gone and leaves the same order open for another choice", async () => {
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a"), offer("b")];
    const hostId = await env.create();
    const choice = await env.awaitChoice();
    env.api.plans.lease.push("refused");
    await expect(
      env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5)
    ).rejects.toMatchObject({
      userMessage: expect.stringContaining("the order is still open"),
    });
    await vi.waitFor(() =>
      expect(env.status()?.pendingCreate?.offers.map((o) => o.id)).toEqual(["b"])
    );
    expect(env.status()?.pendingCreate).toMatchObject({
      order: { id: choice.order.id },
      waitingSince: choice.waitingSince,
    });
    expect(env.status()?.resourceId).toBeNull();
    // Nothing else was leased in its place.
    expect(env.api.leaseOffer).toHaveBeenCalledTimes(1);
    await expect(
      env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5)
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });

    await env.lifecycle.chooseOffer(hostId, choice.order.id, "b", 0.5);
    await env.settled();
    expect(env.status()?.resourceId).toBe(`lease-${choice.order.id}`);
  });

  it("never leases an offer quoted again at a rate the person didn't see", async () => {
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a", 0.5)];
    const hostId = await env.create();
    const choice = await env.awaitChoice();
    // The bidder quotes again under the same id between two reads.
    env.api.orders.get(choice.order.id)!.offers = [offer("a", 0.9)];
    await expect(
      env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5)
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("Nothing was leased") });
    expect(env.api.leaseOffer).not.toHaveBeenCalled();
    // The order stays open, now showing the rate the bidder quotes.
    expect(env.status()?.pendingCreate).toMatchObject({
      order: { id: choice.order.id },
      offers: [{ id: "a", hourlyDollars: 0.9 }],
    });
    await env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.9);
    await env.settled();
    expect(env.status()?.resourceId).toBe(`lease-${choice.order.id}`);
    expect(env.api.leaseOffer).toHaveBeenCalledTimes(1);
  });

  it("leaves the order open when the bidder quotes again after Daintree's last read", async () => {
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a", 0.5)];
    const hostId = await env.create();
    const choice = await env.awaitChoice();
    env.api.plans.lease.push("requote");
    await expect(
      env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5)
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("the order is still open") });
    expect(env.api.orders.get(choice.order.id)?.state).toBe("open");
    expect(env.api.machines.size).toBe(0);
    await vi.waitFor(() =>
      expect(env.status()?.pendingCreate?.offers).toMatchObject([{ id: "a", hourlyDollars: 0.9 }])
    );
  });

  it("reads an offer the provider no longer has as nothing leased, keeping the order", async () => {
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a"), offer("b")];
    const hostId = await env.create();
    const choice = await env.awaitChoice();
    env.api.plans.lease.push("gone");
    await expect(
      env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5)
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("choose another offer") });
    expect(env.api.closeOrder).not.toHaveBeenCalled();
    expect(env.api.orders.get(choice.order.id)?.state).toBe("open");
    await vi.waitFor(() =>
      expect(env.status()?.pendingCreate?.offers.map((o) => o.id)).toEqual(["b"])
    );
  });

  it("looks for an order whose placement answered without naming it", async () => {
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a")];
    env.api.plans.place.push("no-id");
    await env.create();
    const choice = await env.awaitChoice();
    expect(env.api.openOrders()).toEqual([choice.order.id]);
    expect(env.store.createOrders()).toMatchObject([
      { state: "open", orderIds: [choice.order.id] },
    ]);
    expect(env.api.placeOrder).toHaveBeenCalledTimes(1);
  });

  it("closes the host's newer order once an older one's lease is bound, and refuses its choice", async () => {
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a")];
    const hostId = await env.create();
    const newer = await env.awaitChoice();
    const binding = env.store.bindings()[0]!;
    // An earlier placement of this host, found and leased where this device didn't see it.
    const older = env.api.commitLate({ labels: { daintree: "1" }, idempotencyKey: "older" });
    const leased = env.api.leaseElsewhere(older);
    env.store.putCreateOrder({
      id: "co_older",
      bindingId: binding.id,
      accountId: env.account.id,
      providerId: "boat",
      labels: { daintree: "1" },
      idempotencyKey: "older",
      state: "close",
      orderIds: [older],
      placedAt: env.clock.at,
      waitingSince: null,
      offerId: null,
    });
    env.crash();
    await vi.waitFor(() => expect(env.status()?.resourceId).toBe(leased));
    await vi.waitFor(() => expect(env.api.orders.get(newer.order.id)?.state).toBe("closed"));
    expect(env.status()?.pendingCreate).toBeUndefined();
    await expect(env.lifecycle.chooseOffer(hostId, newer.order.id, "a", 0.5)).rejects.toMatchObject(
      { code: "VALIDATION" }
    );
    expect(env.api.leaseOffer).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
  });

  it("closes an order left open on a host that has its machine, and refuses its choice meanwhile", async () => {
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a")];
    const hostId = await env.create();
    const first = await env.awaitChoice();
    await env.lifecycle.chooseOffer(hostId, first.order.id, "a", 0.5);
    await env.settled();
    // A second order the host still names as open: written before a crash cut its close short.
    const stray = env.api.commitLate({ labels: { daintree: "1" }, idempotencyKey: "stray" });
    const binding = env.store.bindings()[0]!;
    env.store.putCreateOrder({
      id: "co_stray",
      bindingId: binding.id,
      accountId: env.account.id,
      providerId: "boat",
      labels: { daintree: "1" },
      idempotencyKey: "stray",
      state: "open",
      orderIds: [stray],
      placedAt: env.clock.at,
      waitingSince: env.clock.at,
      offerId: null,
    });
    await expect(env.lifecycle.chooseOffer(hostId, stray, "a", 0.5)).rejects.toMatchObject({
      userMessage: "This host has its machine already.",
    });
    env.crash();
    await vi.waitFor(() => expect(env.api.orders.get(stray)?.state).toBe("closed"));
    await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
    expect(env.api.leaseOffer).toHaveBeenCalledTimes(1);
  });

  it("won't delete a host whose lease may have landed while its provider takes no orders", async () => {
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a")];
    const hostId = await env.create();
    const choice = await env.awaitChoice();
    env.api.plans.close.push("fail");
    await expect(env.lifecycle.cancelOrder(hostId, choice.order.id)).rejects.toThrow();
    delete (env.provider as { offerCreate?: unknown }).offerCreate;
    await expect(env.lifecycle.deleteMachine(hostId, null)).rejects.toMatchObject({
      userMessage: expect.stringContaining("may have gone through"),
    });
    expect(env.hosts.map((host) => host.id)).toEqual([hostId]);
    expect(env.store.createOrders()).toMatchObject([{ state: "close" }]);
  });

  it("deletes the machine of a bound host whose provider no longer takes orders", async () => {
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a")];
    const hostId = await env.create();
    const choice = await env.awaitChoice();
    await env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5);
    await env.settled();
    const binding = env.store.bindings()[0]!;
    env.store.putCreateOrder({
      id: "co_left",
      bindingId: binding.id,
      accountId: env.account.id,
      providerId: "boat",
      labels: { daintree: "1" },
      idempotencyKey: "left",
      state: "close",
      orderIds: ["dseq-left"],
      placedAt: env.clock.at,
      waitingSince: null,
      offerId: null,
    });
    delete (env.provider as { offerCreate?: unknown }).offerCreate;
    await env.lifecycle.deleteMachine(hostId, binding.resourceId);
    expect(env.api.deleted).toEqual([`lease-${choice.order.id}`]);
    expect(env.hosts).toEqual([]);
  });

  it("deletes a host whose provider no longer takes orders, leaving its order to be closed", async () => {
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a")];
    const hostId = await env.create();
    await env.awaitChoice();
    delete (env.provider as { offerCreate?: unknown }).offerCreate;
    await env.lifecycle.deleteMachine(hostId, null);
    expect(env.hosts).toEqual([]);
    expect(env.store.createOrders()).toMatchObject([{ state: "close" }]);
  });

  it("refuses a Retry once the provider no longer creates through offers, sending nothing", async () => {
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a")];
    const hostId = await env.create();
    await env.awaitChoice();
    delete (env.provider as { offerCreate?: unknown }).offerCreate;
    await expect(env.lifecycle.retryCreate(hostId)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(env.status()?.lastError?.code).toBe("unsupported");
    expect(env.provider.create).not.toHaveBeenCalled();
    expect(env.store.createOrders()).toHaveLength(1);
  });

  it("never acts on an order record naming another provider's account", async () => {
    const env = await offerCloud();
    env.store.putCreateOrder({
      id: "co_stray",
      bindingId: "cb_000000000001",
      accountId: env.account.id,
      providerId: "agent37",
      labels: { daintree: "1" },
      idempotencyKey: "key",
      state: "close",
      orderIds: ["dseq-9"],
      placedAt: env.clock.at,
      waitingSince: null,
      offerId: null,
    });
    env.crash();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(env.api.closeOrder).not.toHaveBeenCalled();
    expect(env.store.createOrders()).toHaveLength(1);
    await expect(env.accounts.removeAccount(env.account.id)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    expect(env.store.account(env.account.id)).not.toBeNull();
  });

  describe("a lost reply to placing the order", () => {
    it("finds the order it placed and brings back the choice, placing nothing again", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      env.api.plans.place.push("lost");
      await env.create();
      const choice = await env.awaitChoice();
      expect(env.api.openOrders()).toEqual([choice.order.id]);
      expect(env.api.placeOrder).toHaveBeenCalledTimes(1);
      expect(env.status()?.lastError).toBeNull();
    });

    it("keeps looking for a placement that hasn't shown up, and brings back the choice when it does", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      env.api.plans.place.push("unsent");
      await env.create();
      await env.settled();
      expect(env.status()?.lastError?.code).toBe("outcome-unknown");
      const [record] = env.store.createOrders();
      expect(record).toMatchObject({ state: "placing", orderIds: null });
      // It lands late, while Daintree is still looking.
      const id = env.api.commitLate(record!);
      env.clock.at += 61_000;
      await vi.advanceTimersByTimeAsync(60_000);
      const choice = await env.awaitChoice();
      expect(choice.order.id).toBe(id);
      expect(choice.waitingSince).toBe(env.clock.at);
      expect(env.status()?.lastError).toBeNull();
      expect(env.api.placeOrder).toHaveBeenCalledTimes(1);
    });

    it("counts a placement unseen for the whole window as never placed", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      env.api.plans.place.push("unsent");
      await env.create();
      await env.settled();
      expect(env.store.createOrders()).toHaveLength(1);
      env.clock.at += 5 * 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(env.store.createOrders()).toHaveLength(1);
      env.clock.at += 6 * 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.status()?.lastError).toMatchObject({
        code: "failed",
        message: expect.stringContaining("Retry places a new order"),
      });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("closes every order when the lost placement left more than one", async () => {
      const env = await offerCloud();
      env.api.plans.place.push("lost-twice");
      const hostId = await env.create();
      await env.settled();
      expect(env.api.openOrders()).toEqual([]);
      expect(env.store.createOrders()).toEqual([]);
      expect(env.status()?.lastError?.message).toContain("more than one");
      // Retry places a fresh one, under a key of its own.
      await env.lifecycle.retryCreate(hostId);
      expect(env.status()?.pendingCreate?.order.id).toBeDefined();
      expect(env.api.placeOrder).toHaveBeenCalledTimes(2);
      const [first, second] = env.api.placeOrder.mock.calls.map(([, request]) => request);
      expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
    });
  });

  describe("a lost reply to the lease", () => {
    it("binds the machine the close says was leased, leasing nothing again", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("lost");
      await env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5);
      await env.settled();
      expect(env.status()?.resourceId).toBe(`lease-${choice.order.id}`);
      expect(env.status()?.machine).toBe("running");
      expect(env.api.leaseOffer).toHaveBeenCalledTimes(1);
      expect(env.api.closeOrder).toHaveBeenCalledWith(expect.anything(), choice.order.id);
      expect(env.store.createOrders()).toEqual([]);
    });

    it("closes the order when the lease never landed, and Retry places a new one", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("unsent");
      await expect(
        env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5)
      ).rejects.toMatchObject({ userMessage: expect.stringContaining("no machine was leased") });
      expect(env.api.orders.get(choice.order.id)?.state).toBe("closed");
      expect(env.status()?.resourceId).toBeNull();
      expect(env.status()?.pendingCreate).toBeUndefined();
      expect(env.status()?.lastError?.message).toContain("closed the order");
      await env.lifecycle.retryCreate(hostId);
      const next = await env.awaitChoice();
      expect(next.order.id).not.toBe(choice.order.id);
    });
  });

  describe("a cancel racing a lease", () => {
    it("keeps the machine when the lease won, and carries on", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("hang-commit");
      const chosen = env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5);
      chosen.catch(() => {});
      await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
      await env.lifecycle.cancelOrder(hostId, choice.order.id);
      expect(env.status()?.resourceId).toBe(`lease-${choice.order.id}`);
      // The create carries on: the machine is waited on until it runs.
      await vi.waitFor(() => expect(env.status()?.machine).toBe("running"));
      await env.settled();
      expect(env.status()?.lastError).toBeNull();
      expect(env.store.createOrders()).toEqual([]);
      expect(env.api.leaseOffer).toHaveBeenCalledTimes(1);
    });

    it("keeps showing the choice while its lease is out, so a refusal reaches the view that chose", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("hang");
      const chosen = env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5);
      chosen.catch(() => {});
      await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
      expect(env.status()?.operation?.kind).toBe("creating");
      expect(env.status()?.pendingCreate).toMatchObject({
        order: { id: choice.order.id },
        waitingSince: choice.waitingSince,
      });
      await env.lifecycle.cancelOrder(hostId, choice.order.id);
      expect(env.status()?.pendingCreate).toBeUndefined();
    });

    it("closes the order when the cancel won, leasing nothing", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("hang");
      const chosen = env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5);
      await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
      await env.lifecycle.cancelOrder(hostId, choice.order.id);
      await expect(chosen).rejects.toThrow();
      expect(env.api.orders.get(choice.order.id)?.state).toBe("closed");
      expect(env.status()?.resourceId).toBeNull();
      expect(env.status()?.pendingCreate).toBeUndefined();
      expect(env.status()?.lastError?.message).toContain("cancelled");
      expect(env.store.createOrders()).toEqual([]);
      // A choice from the view that still shows the order changes nothing.
      await expect(
        env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5)
      ).rejects.toMatchObject({
        code: "VALIDATION",
      });
      expect(env.api.leaseOffer).toHaveBeenCalledTimes(1);
    });

    it("keeps trying to close a cancelled order it couldn't close, and keeps its record", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.close.push("fail");
      await expect(env.lifecycle.cancelOrder(hostId, choice.order.id)).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
      });
      expect(env.store.createOrders()).toMatchObject([{ state: "close" }]);
      expect(env.status()?.pendingCreate).toBeUndefined();
      expect(env.status()?.lastError).toMatchObject({
        code: "outcome-unknown",
        message: expect.stringContaining("keeps trying"),
      });
      env.clock.at += 61_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.api.orders.get(choice.order.id)?.state).toBe("closed");
    });
  });

  it("clears a cancelled create's error once Retry's order waits on a choice", async () => {
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a")];
    const hostId = await env.create();
    const choice = await env.awaitChoice();
    await env.lifecycle.cancelOrder(hostId, choice.order.id);
    expect(env.status()?.lastError?.message).toContain("cancelled");
    env.clock.at += 60_000;
    await env.lifecycle.retryCreate(hostId);
    const next = await env.awaitChoice();
    expect(next.order.id).not.toBe(choice.order.id);
    expect(env.status()?.lastError).toBeNull();
  });

  describe("a restart", () => {
    it("after the order was written down but before it was answered: finds it and brings back the choice", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      env.api.plans.place.push("hang-commit");
      await env.create();
      await vi.waitFor(() => expect(env.api.placeOrder).toHaveBeenCalledTimes(1));
      env.crash();
      const choice = await env.awaitChoice();
      expect(env.api.openOrders()).toEqual([choice.order.id]);
      expect(env.api.placeOrder).toHaveBeenCalledTimes(1);
      expect(env.status()?.lastError).toBeNull();
    });

    it("while waiting on a choice: the choice comes back with the same order and when it began", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      await env.create();
      const before = await env.awaitChoice();
      env.clock.at += 30_000;
      env.crash();
      const after = await env.awaitChoice();
      expect(after.order).toEqual(before.order);
      expect(after.waitingSince).toBe(before.waitingSince);
      expect(after.offersReadAt).toBe(env.clock.at);
      expect(env.status()?.lastError).toBeNull();
      expect(env.api.placeOrder).toHaveBeenCalledTimes(1);
    });

    it("after a lease was sent: binds the machine it made, never leasing again", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("hang-commit");
      void env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5).catch(() => {});
      await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
      env.crash();
      await vi.waitFor(() => expect(env.status()?.resourceId).toBe(`lease-${choice.order.id}`));
      expect(env.store.createOrders()).toEqual([]);
      expect(env.api.leaseOffer).toHaveBeenCalledTimes(1);
    });

    it("after a lease was sent that never landed: closes the order and offers Retry", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("hang");
      void env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5).catch(() => {});
      await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
      env.crash();
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.api.orders.get(choice.order.id)?.state).toBe("closed");
      expect(env.status()).toMatchObject({ resourceId: null, operation: null });
      expect(env.status()?.lastError).toMatchObject({
        code: "failed",
        message: expect.stringContaining("Retry places a new order"),
      });
      expect(env.api.leaseOffer).toHaveBeenCalledTimes(1);
      expect(env.api.placeOrder).toHaveBeenCalledTimes(1);
    });

    it("while a close is still owed: closes it, after its host has gone", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.close.push("fail");
      env.removeHost(hostId);
      await vi.waitFor(() => expect(env.api.closeOrder).toHaveBeenCalledTimes(1));
      expect(env.store.createOrders()).toMatchObject([{ state: "close" }]);
      env.crash();
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.api.orders.get(choice.order.id)?.state).toBe("closed");
      expect(env.api.leaseOffer).not.toHaveBeenCalled();
    });
  });

  describe("removal", () => {
    it("deleting the host closes its open order", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      await env.lifecycle.deleteMachine(hostId, null);
      expect(env.hosts).toEqual([]);
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.api.orders.get(choice.order.id)?.state).toBe("closed");
      expect(env.store.bindings()).toEqual([]);
    });

    it("deleting the host while a lease is out deletes the machine the lease made", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("hang-commit");
      void env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5).catch(() => {});
      await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
      await env.lifecycle.deleteMachine(hostId, null);
      expect(env.api.deleted).toEqual([`lease-${choice.order.id}`]);
      expect(env.hosts).toEqual([]);
      expect(env.store.createOrders()).toEqual([]);
    });

    it("deleting the host deletes a machine leased from its order where this device never saw it", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      const leased = env.api.leaseElsewhere(choice.order.id);
      await env.lifecycle.deleteMachine(hostId, null);
      expect(env.api.deleted).toEqual([leased]);
      expect(env.hosts).toEqual([]);
      expect(env.store.createOrders()).toEqual([]);
    });

    it("keeps the host when its order can't be closed for a delete, and keeps closing it", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.close.push("fail");
      await expect(env.lifecycle.deleteMachine(hostId, null)).rejects.toThrow();
      expect(env.hosts.map((host) => host.id)).toEqual([hostId]);
      expect(env.store.createOrders()).toMatchObject([{ state: "close" }]);
      env.clock.at += 61_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.api.orders.get(choice.order.id)?.state).toBe("closed");
      expect(env.status()?.lastError?.message).toContain("Retry places a new order");
    });

    it("removing the host from the list keeps closing its order until the provider confirms", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.close.push("fail", "fail");
      env.removeHost(hostId);
      await vi.waitFor(() => expect(env.api.closeOrder).toHaveBeenCalledTimes(1));
      expect(env.store.bindings()).toEqual([]);
      expect(env.store.createOrders()).toMatchObject([
        { state: "close", orderIds: [choice.order.id] },
      ]);
      env.clock.at += 61_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(env.api.closeOrder).toHaveBeenCalledTimes(2));
      expect(env.store.createOrders()).toHaveLength(1);
      env.clock.at += 61_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.api.orders.get(choice.order.id)?.state).toBe("closed");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("removing the account closes its orders first, and is refused while one stays open", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.close.push("fail", "fail");
      await env.lifecycle.forgetAccountHosts(env.account.id);
      await vi.waitFor(() => expect(env.api.closeOrder).toHaveBeenCalledTimes(1));
      await expect(env.accounts.removeAccount(env.account.id)).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
      });
      // The credentials that can still close it stay.
      expect(env.store.account(env.account.id)).not.toBeNull();
      expect(env.store.createOrders()).toHaveLength(1);
      await env.accounts.removeAccount(env.account.id);
      expect(env.store.account(env.account.id)).toBeNull();
      expect(env.store.createOrders()).toEqual([]);
      expect(env.api.orders.get(choice.order.id)?.state).toBe("closed");
    });

    it("refuses a create on an account while it is being removed", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const env = await offerCloud({ beforeRemoval: () => held });
      const removal = env.accounts.removeAccount(env.account.id);
      await expect(env.create()).rejects.toMatchObject({
        userMessage: expect.stringContaining("is being removed"),
      });
      release();
      await removal;
      expect(env.store.bindings()).toEqual([]);
      expect(env.api.placeOrder).not.toHaveBeenCalled();
    });

    it("takes a key that can't say whose it is only when it reaches an order still owed a close", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.close.push("fail");
      env.removeHost(hostId);
      await vi.waitFor(() => expect(env.api.closeOrder).toHaveBeenCalledTimes(1));
      env.provider.checkCredentials = async () => ({
        identity: null,
        scopes: [
          { scope: { kind: "personal" as const, id: "personal", name: "Personal" }, active: true },
        ],
      });
      // The order is still open at the provider: the new key reads it, so it is this workspace's.
      await env.accounts.replaceCredentials(env.account.id, { apiKey: "boat_live_y" });
      expect(env.api.listOffers).toHaveBeenLastCalledWith(
        expect.objectContaining({ values: { apiKey: "boat_live_y" } }),
        choice.order.id
      );
      // Once it is closed nothing proves whose a key is, so the next one is refused.
      env.api.orders.get(choice.order.id)!.state = "closed";
      await expect(
        env.accounts.replaceCredentials(env.account.id, { apiKey: "boat_live_z" })
      ).rejects.toMatchObject({ userMessage: expect.stringContaining("can't reach it") });
    });

    it("takes a new key for a host waiting on an offer once the key reaches its order", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      await env.create();
      const choice = await env.awaitChoice();
      env.provider.checkCredentials = async () => ({
        identity: null,
        scopes: [
          { scope: { kind: "personal" as const, id: "personal", name: "Personal" }, active: true },
        ],
      });
      await env.accounts.replaceCredentials(env.account.id, { apiKey: "boat_live_y" });
      expect(env.api.listOffers).toHaveBeenLastCalledWith(
        expect.objectContaining({ values: { apiKey: "boat_live_y" } }),
        choice.order.id
      );
      expect(env.status()?.pendingCreate?.order.id).toBe(choice.order.id);
    });

    it("keeps an account whose order record this build can't read", async () => {
      const env = await offerCloud();
      env.saved.set("cloudCreateOrders", [
        { id: "co_future", accountId: env.account.id, state: "someday-later" },
      ]);
      await expect(env.accounts.removeAccount(env.account.id)).rejects.toMatchObject({
        userMessage: expect.stringContaining("can't read"),
      });
      expect(env.store.account(env.account.id)).not.toBeNull();
    });
  });
});
