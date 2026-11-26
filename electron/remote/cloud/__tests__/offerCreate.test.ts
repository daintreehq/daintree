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
 * arrives, after Daintree's last read. `held`: a lease reaches the provider,
 * which answers it only when the test says how (`answerLease`); aborting the
 * request meanwhile loses the answer, never the lease.
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
  | "held"
  | "fail";

/** How the provider answers a held lease: it lands, it is turned down, or it lands and the answer is lost. */
type HeldAnswer = "accept" | "refuse" | "lost";

interface FakeOrder {
  labels: Record<string, string>;
  idempotencyKey: string;
  state: "open" | "closed" | "leased";
  offers: CloudCreateOffer[];
  machine: ProviderResource | null;
  /** The rate its lease runs at, once leased. */
  leasedAt?: number;
}

/** An offer-based provider's account: orders, their offers, and the machines leased from them. */
class FakeOffers {
  readonly orders = new Map<string, FakeOrder>();
  readonly machines = new Map<string, ProviderResource>();
  readonly deleted: string[] = [];
  /** Runs as each delete reaches the provider, before it acts. */
  beforeDelete: (() => void) | null = null;
  /** How many deletes to come fail, leaving the machine. */
  deletesFailing = 0;
  /** How many deletes to come delete the machine and lose their answer. */
  deletesLosingAnswer = 0;
  readonly plans: Record<"place" | "lease" | "close" | "read", Plan[]> = {
    place: [],
    lease: [],
    close: [],
    read: [],
  };
  /** Offers every new order gets. */
  offersOnPlace: CloudCreateOffer[] = [];
  /** Whether a close or read that finds a lease says the rate it runs at. */
  reportsLeaseRate = true;
  /** What was stored when each placement and lease reached the provider. */
  readonly storedAtSend: Array<StoredCreateOrder[]> = [];
  storedNow: () => StoredCreateOrder[] = () => [];
  /** Every order request that reached the provider, in order. */
  readonly sent: string[] = [];
  /** Whether a held lease's answer still reaches a request that was aborted, as a reply in flight can. */
  answersAborted = false;
  /** Leases sent and not yet answered, by order. */
  private readonly leasesOut = new Map<string, number>();
  /** Closes that reached the provider while a lease of the same order was still unanswered. */
  readonly closedDuringLease: string[] = [];
  private readonly heldLeases: Array<(answer: HeldAnswer) => void> = [];
  private next = 0;

  /** Answers the oldest held lease. */
  answerLease(answer: HeldAnswer = "accept"): void {
    const held = this.heldLeases.shift();
    if (!held) throw new Error("No lease is held");
    held(answer);
  }

  private plan(kind: "place" | "lease" | "close" | "read"): Plan {
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

  private readonly held = new Map<"list" | "close" | "delete", Promise<void>>();

  /**
   * Holds the next request of this kind once it reaches the provider, until
   * the returned function is called. A held read answers with what it read
   * when it arrived; a held close or delete acts when released.
   */
  holdNext(kind: "list" | "close" | "delete"): () => void {
    let release!: () => void;
    this.held.set(kind, new Promise<void>((resolve) => (release = resolve)));
    return release;
  }

  /** Resolves when a held request of this kind is let go; at once when none is held. */
  async waitHeld(kind: "list" | "close" | "delete"): Promise<void> {
    const held = this.held.get(kind);
    this.held.delete(kind);
    if (held) await held;
  }

  readonly listOffers = vi.fn(async (_credentials: unknown, orderId: string) => {
    const order = this.orders.get(orderId);
    const read =
      !order || order.state !== "open"
        ? Promise.reject(new Refusal("not-found", "No such order."))
        : Promise.resolve([...order.offers]);
    read.catch(() => {});
    await this.waitHeld("list");
    return read;
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
      if (plan !== "unsent") this.sent.push(`lease ${orderId}`);
      this.leasesOut.set(orderId, (this.leasesOut.get(orderId) ?? 0) + 1);
      const done = () => this.leasesOut.set(orderId, this.leasesOut.get(orderId)! - 1);
      if (plan !== "held") {
        try {
          return await this.lease(plan, credentials.signal, orderId, offerId, expected);
        } finally {
          done();
        }
      }
      // The provider has it, and acts on it once answered whatever the request does meanwhile:
      // an abort only loses the answer.
      const answered = new Promise<HeldAnswer>((resolve) => this.heldLeases.push(resolve)).then(
        (answer) =>
          this.lease(
            answer === "accept" ? "ok" : answer === "refuse" ? "refused" : "lost",
            undefined,
            orderId,
            offerId,
            expected
          ).finally(done)
      );
      answered.catch(() => {});
      return new Promise<ProviderResource>((resolve, reject) => {
        answered.then(resolve, reject);
        if (this.answersAborted) return;
        credentials.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }
  );

  private async lease(
    plan: Plan,
    signal: AbortSignal | undefined,
    orderId: string,
    offerId: string,
    expected?: { hourlyDollars: number }
  ): Promise<ProviderResource> {
    const order = this.orders.get(orderId);
    if (plan === "unsent") throw lost();
    if (plan === "hang") return this.hang<ProviderResource>(signal);
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
    order.leasedAt = quoted.hourlyDollars;
    this.machines.set(leased.resourceId, machine(leased.resourceId, order.labels));
    if (plan === "lost") throw lost();
    if (plan === "hang-commit") return this.hang<ProviderResource>(signal);
    return leased;
  }

  readonly closeOrder = vi.fn(async (_credentials: unknown, orderId: string) => {
    this.sent.push(`close ${orderId}`);
    if ((this.leasesOut.get(orderId) ?? 0) > 0) this.closedDuringLease.push(orderId);
    await this.waitHeld("close");
    if (this.plan("close") === "fail") throw lost();
    const order = this.orders.get(orderId);
    if (order?.state === "leased") {
      return {
        kind: "leased" as const,
        resource: order.machine!,
        hourlyDollars: this.reportsLeaseRate ? (order.leasedAt ?? null) : null,
      };
    }
    if (order) order.state = "closed";
    return { kind: "closed" as const };
  });

  readonly readOrder = vi.fn(async (_credentials: unknown, orderId: string) => {
    this.sent.push(`read ${orderId}`);
    if (this.plan("read") === "fail") throw lost();
    const order = this.orders.get(orderId);
    if (order?.state === "leased") {
      return {
        kind: "leased" as const,
        resource: order.machine!,
        hourlyDollars: this.reportsLeaseRate ? (order.leasedAt ?? null) : null,
      };
    }
    return { kind: order?.state === "open" ? ("open" as const) : ("closed" as const) };
  });

  /** A lease made where this device never saw it: the person's console, say. */
  leaseElsewhere(orderId: string, hourlyDollars = 0.5): string {
    const order = this.orders.get(orderId)!;
    const leased = machine(`lease-${orderId}`, order.labels);
    order.state = "leased";
    order.machine = leased;
    order.leasedAt = hourlyDollars;
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
      api.beforeDelete?.();
      await api.waitHeld("delete");
      if (api.deletesFailing > 0) {
        api.deletesFailing -= 1;
        throw lost();
      }
      if (!api.machines.has(resourceId)) throw new Refusal("not-found", "No such machine.");
      api.deleted.push(resourceId);
      api.machines.delete(resourceId);
      // Deleting a leased machine closes the order it was leased from.
      for (const order of api.orders.values()) {
        if (order.machine?.resourceId === resourceId) order.state = "closed";
      }
      if (api.deletesLosingAnswer > 0) {
        api.deletesLosingAnswer -= 1;
        throw lost();
      }
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
      readOrder: api.readOrder,
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

type Env = Awaited<ReturnType<typeof offerCloud>>;

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
    it("tries a read that failed again on the keeper's next pass, closing nothing", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("lost");
      env.api.plans.read.push("fail");
      await expect(
        env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5)
      ).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        userMessage: expect.stringContaining("couldn't be read back yet"),
      });
      expect(env.store.createOrders()).toMatchObject([{ state: "leasing", offerId: "a" }]);
      env.clock.at += 61_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(env.status()?.resourceId).toBe(`lease-${choice.order.id}`));
      expect(env.store.createOrders()).toEqual([]);
      expect(env.api.closeOrder).not.toHaveBeenCalled();
      expect(env.api.placeOrder).toHaveBeenCalledTimes(1);
    });

    it("binds the machine a read of the order says was leased, sending no close", async () => {
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
      expect(env.api.sent).toEqual([`lease ${choice.order.id}`, `read ${choice.order.id}`]);
      expect(env.api.closeOrder).not.toHaveBeenCalled();
      expect(env.store.createOrders()).toEqual([]);
    });

    it("keeps an order whose lease may still land until the create is cancelled, closing nothing meanwhile", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("unsent");
      await expect(
        env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5)
      ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      // Read back at once, before anything else is sent.
      expect(env.api.readOrder).toHaveBeenCalledTimes(1);
      expect(env.status()?.lastError).toMatchObject({
        code: "outcome-unknown",
        message: expect.stringContaining("Cancel closes the order instead"),
      });
      expect(env.store.createOrders()).toMatchObject([{ state: "leasing", offerId: "a" }]);
      // It is read back on the keeper's passes, however long that takes, and never closed.
      for (let pass = 0; pass < 12; pass += 1) {
        env.clock.at += 61_000;
        await vi.advanceTimersByTimeAsync(60_000);
      }
      await vi.waitFor(() =>
        expect(env.api.readOrder.mock.calls.length).toBeGreaterThanOrEqual(12)
      );
      expect(env.api.closeOrder).not.toHaveBeenCalled();
      expect(env.api.orders.get(choice.order.id)?.state).toBe("open");
      // Nothing is placed beside it, which could make a second machine.
      await expect(env.lifecycle.retryCreate(hostId)).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
      });
      expect(env.api.placeOrder).toHaveBeenCalledTimes(1);

      await env.lifecycle.cancelOrder(hostId, choice.order.id);
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.api.orders.get(choice.order.id)?.state).toBe("closed");
      expect(env.api.sent.slice(-2)).toEqual([
        `read ${choice.order.id}`,
        `close ${choice.order.id}`,
      ]);
      expect(env.status()?.lastError?.message).toContain("cancelled");
      await env.lifecycle.retryCreate(hostId);
      const next = await env.awaitChoice();
      expect(next.order.id).not.toBe(choice.order.id);
    });

    it("binds a lease that lands long after its answer was lost", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("unsent");
      await expect(
        env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5)
      ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(env.status()?.lastError?.code).toBe("outcome-unknown");
      env.clock.at += 20 * 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      const leased = env.api.leaseElsewhere(choice.order.id, 0.5);
      env.clock.at += 61_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(env.status()?.resourceId).toBe(leased));
      expect(env.status()?.lastError).toBeNull();
      expect(env.store.createOrders()).toEqual([]);
      expect(env.api.closeOrder).not.toHaveBeenCalled();
    });
  });

  describe("a cancel racing a lease", () => {
    /** Chooses the offer with a lease the provider holds until the test answers it. */
    async function leaseHeld(env: Env, hourlyDollars = 0.5) {
      env.api.offersOnPlace = [offer("a", hourlyDollars)];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("held");
      const chosen = env.lifecycle.chooseOffer(hostId, choice.order.id, "a", hourlyDollars);
      chosen.catch(() => {});
      await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
      return { hostId, orderId: choice.order.id, chosen };
    }

    it("waits for a lease the provider took before the cancel, then deletes the machine it made", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      const { hostId, orderId, chosen } = await leaseHeld(env);
      await env.lifecycle.cancelOrder(hostId, orderId);
      // A second press, from a view that hadn't caught up, changes nothing.
      await env.lifecycle.cancelOrder(hostId, orderId);
      // The cancel is written down and the choice is gone, while the lease's request stays out.
      expect(env.store.createOrders()).toMatchObject([
        { state: "leasing", offerId: "a", cancelled: true },
      ]);
      expect(env.status()?.pendingCreate).toBeUndefined();
      expect(env.status()?.operation?.kind).toBe("creating");
      // The keeper's passes send nothing for the order while its lease is out.
      for (let pass = 0; pass < 3; pass += 1) {
        env.clock.at += 61_000;
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expect(env.api.sent).toEqual([`lease ${orderId}`]);

      // It lands, and only then answers: the machine is bound, then deleted like any other.
      let atDelete: ReturnType<Env["status"]> | undefined;
      env.api.beforeDelete = () => (atDelete = env.status());
      env.api.answerLease("accept");
      await expect(chosen).rejects.toMatchObject({ code: "CANCELLED" });
      await vi.waitFor(() => expect(env.api.deleted).toEqual([`lease-${orderId}`]));
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.provider.delete).toHaveBeenCalledTimes(1);
      expect(atDelete).toMatchObject({
        resourceId: `lease-${orderId}`,
        operation: { kind: "deleting" },
      });
      expect(env.api.closeOrder).not.toHaveBeenCalled();
      expect(env.api.closedDuringLease).toEqual([]);
      expect(env.api.machines.size).toBe(0);
      expect(env.status()).toMatchObject({ resourceId: null, operation: null });
      expect(env.status()?.lastError?.message).toContain(
        "leased just before the cancel, and Daintree has deleted it"
      );
      expect(env.api.leaseOffer).toHaveBeenCalledTimes(1);
      // The host is as any cancelled create leaves it: Retry places a new order.
      env.clock.at += 61_000;
      await env.lifecycle.retryCreate(hostId);
      const next = await env.awaitChoice();
      expect(next.order.id).not.toBe(orderId);
    });

    it("deletes a lease that landed after the cancel again when its delete failed, after a restart too", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      const { hostId, orderId } = await leaseHeld(env);
      await env.lifecycle.cancelOrder(hostId, orderId);
      env.api.deletesFailing = 1;
      env.api.answerLease("accept");
      await vi.waitFor(() => expect(env.provider.delete).toHaveBeenCalledTimes(1));
      await env.settled();
      // The machine is still the host's, and still to be deleted, whatever happens next.
      expect(env.status()?.resourceId).toBe(`lease-${orderId}`);
      expect(env.store.createOrders()).toMatchObject([{ state: "leasing", cancelled: true }]);
      env.crash();
      await vi.waitFor(() => expect(env.api.deleted).toEqual([`lease-${orderId}`]));
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.status()?.resourceId).toBeNull();
      expect(env.status()?.lastError?.message).toContain("leased just before the cancel");
      expect(env.api.closeOrder).not.toHaveBeenCalled();
      expect(env.api.leaseOffer).toHaveBeenCalledTimes(1);
    });

    it("reads the order back when the lease's answer is lost after the cancel, and deletes what it leased", async () => {
      const env = await offerCloud();
      const { hostId, orderId, chosen } = await leaseHeld(env);
      await env.lifecycle.cancelOrder(hostId, orderId);
      env.api.answerLease("lost");
      await expect(chosen).rejects.toMatchObject({ code: "CANCELLED" });
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.api.sent).toEqual([`lease ${orderId}`, `read ${orderId}`]);
      expect(env.api.deleted).toEqual([`lease-${orderId}`]);
      expect(env.status()?.resourceId).toBeNull();
      expect(env.status()?.lastError?.message).toContain("leased just before the cancel");
      await env.lifecycle.retryCreate(hostId);
      expect((await env.awaitChoice()).order.id).not.toBe(orderId);
    });

    it("finishes a cancelled lease's delete that went through just before a restart", async () => {
      const env = await offerCloud();
      const { hostId, orderId } = await leaseHeld(env);
      await env.lifecycle.cancelOrder(hostId, orderId);
      env.api.deletesLosingAnswer = 1;
      env.api.answerLease("accept");
      await vi.waitFor(() => expect(env.api.deleted).toEqual([`lease-${orderId}`]));
      await env.settled();
      // The machine is gone, but this run never heard so: the host still names it.
      expect(env.status()?.resourceId).toBe(`lease-${orderId}`);
      expect(env.store.createOrders()).toMatchObject([{ state: "leasing", cancelled: true }]);
      env.crash();
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.status()?.resourceId).toBeNull();
      expect(env.status()?.lastError?.message).toContain("leased just before the cancel");
      expect(env.api.closeOrder).not.toHaveBeenCalled();
      await env.lifecycle.retryCreate(hostId);
      expect((await env.awaitChoice()).order.id).not.toBe(orderId);
    });

    it("deleting the host while a cancelled lease's machine is being deleted waits for that delete", async () => {
      const env = await offerCloud();
      const { hostId, orderId } = await leaseHeld(env);
      await env.lifecycle.cancelOrder(hostId, orderId);
      const releaseDelete = env.api.holdNext("delete");
      env.api.answerLease("accept");
      await vi.waitFor(() => expect(env.provider.delete).toHaveBeenCalledTimes(1));
      const removed = env.lifecycle.deleteMachine(hostId, `lease-${orderId}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(env.hosts.map((host) => host.id)).toEqual([hostId]);
      releaseDelete();
      await removed;
      expect(env.provider.delete).toHaveBeenCalledTimes(1);
      expect(env.api.deleted).toEqual([`lease-${orderId}`]);
      expect(env.hosts).toEqual([]);
      expect(env.store.createOrders()).toEqual([]);
    });

    it("sends nothing for an order whose lease is out after its host leaves the list, and closes it if turned down", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      const { hostId, orderId, chosen } = await leaseHeld(env);
      env.removeHost(hostId);
      await vi.waitFor(() => expect(env.store.bindings()).toEqual([]));
      for (let pass = 0; pass < 3; pass += 1) {
        env.clock.at += 61_000;
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expect(env.api.sent).toEqual([`lease ${orderId}`]);
      expect(env.store.createOrders()).toMatchObject([{ state: "leasing", offerId: "a" }]);
      // Nobody waits on the order now, so a refusal closes it rather than opening it again.
      env.api.answerLease("refuse");
      await expect(chosen).rejects.toMatchObject({
        code: "VALIDATION",
        userMessage: expect.not.stringContaining("has its machine"),
      });
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.api.sent).toEqual([`lease ${orderId}`, `close ${orderId}`]);
      expect(env.api.orders.get(orderId)?.state).toBe("closed");
    });

    it("acts on nothing a quit run's lease answers with", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      // The quit run's request still gets its reply, as one already in flight can.
      env.api.answersAborted = true;
      const { hostId, orderId } = await leaseHeld(env);
      await env.lifecycle.cancelOrder(hostId, orderId);
      env.crash();
      await vi.waitFor(() => expect(env.api.sent).toEqual([`lease ${orderId}`, `read ${orderId}`]));
      env.api.answerLease("accept");
      env.clock.at += 61_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(env.api.deleted).toEqual([`lease-${orderId}`]));
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.provider.delete).toHaveBeenCalledTimes(1);
      expect(env.api.sent).toEqual([`lease ${orderId}`, `read ${orderId}`, `read ${orderId}`]);
    });

    it("lets the close go once a lease sent before the cancel is turned down", async () => {
      const env = await offerCloud();
      const { hostId, orderId, chosen } = await leaseHeld(env);
      await env.lifecycle.cancelOrder(hostId, orderId);
      expect(env.api.closeOrder).not.toHaveBeenCalled();
      env.api.answerLease("refuse");
      await expect(chosen).rejects.toMatchObject({ code: "CANCELLED" });
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.api.sent).toEqual([`lease ${orderId}`, `close ${orderId}`]);
      expect(env.api.closedDuringLease).toEqual([]);
      expect(env.api.orders.get(orderId)?.state).toBe("closed");
      expect(env.status()?.resourceId).toBeNull();
      expect(env.status()?.pendingCreate).toBeUndefined();
      expect(env.status()?.lastError?.message).toContain("cancelled");
      // A second press from the view that still shows it changes nothing.
      await expect(env.lifecycle.cancelOrder(hostId, orderId)).rejects.toMatchObject({
        code: "VALIDATION",
      });
      expect(env.api.closeOrder).toHaveBeenCalledTimes(1);
    });

    it("sends no lease when the cancel comes before it, and closes the order once", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      // The cancel lands while the offer is checked once more, just before the lease would go,
      // and its close is still out when that check answers that the offer stands.
      const releaseList = env.api.holdNext("list");
      const chosen = env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5);
      chosen.catch(() => {});
      await vi.waitFor(() => expect(env.status()?.operation?.stage).toContain("Checking"));
      const releaseClose = env.api.holdNext("close");
      const cancelled = env.lifecycle.cancelOrder(hostId, choice.order.id);
      await vi.waitFor(() => expect(env.api.closeOrder).toHaveBeenCalledTimes(1));
      releaseList();
      await expect(chosen).rejects.toMatchObject({ code: "VALIDATION" });
      expect(env.api.leaseOffer).not.toHaveBeenCalled();
      releaseClose();
      await cancelled;
      await env.settled();
      expect(env.api.leaseOffer).not.toHaveBeenCalled();
      expect(env.api.sent).toEqual([`close ${choice.order.id}`]);
      expect(env.api.orders.get(choice.order.id)?.state).toBe("closed");
      expect(env.store.createOrders()).toEqual([]);
      expect(env.status()?.lastError?.message).toContain("cancelled");
    });

    it("keeps showing the choice while its lease is out, so a refusal reaches the view that chose", async () => {
      const env = await offerCloud();
      const { hostId, orderId, chosen } = await leaseHeld(env);
      expect(env.status()?.operation?.kind).toBe("creating");
      expect(env.status()?.pendingCreate).toMatchObject({ order: { id: orderId } });
      env.api.answerLease("refuse");
      await expect(chosen).rejects.toMatchObject({
        userMessage: expect.stringContaining("the order is still open"),
      });
      expect(env.status()?.pendingCreate).toMatchObject({ order: { id: orderId } });
      expect(env.api.closeOrder).not.toHaveBeenCalled();
      expect(hostId).toBeTruthy();
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
      // The order was read back, and nothing else was sent for it.
      expect(env.api.sent).toEqual([`lease ${choice.order.id}`, `read ${choice.order.id}`]);
    });

    it("with its lease still out at the provider: reads the order back before anything else, and binds the lease once it lands", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("held");
      void env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5).catch(() => {});
      await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
      env.crash();
      await vi.waitFor(() =>
        expect(env.api.sent).toEqual([`lease ${choice.order.id}`, `read ${choice.order.id}`])
      );
      for (let pass = 0; pass < 3; pass += 1) {
        env.clock.at += 61_000;
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expect(env.api.closeOrder).not.toHaveBeenCalled();
      expect(env.store.createOrders()).toMatchObject([{ state: "leasing", offerId: "a" }]);
      // It lands at last, and the next read binds it.
      env.api.answerLease("accept");
      env.clock.at += 61_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(env.status()?.resourceId).toBe(`lease-${choice.order.id}`));
      expect(env.store.createOrders()).toEqual([]);
      expect(env.api.closedDuringLease).toEqual([]);
      expect(env.api.leaseOffer).toHaveBeenCalledTimes(1);
    });

    it("cancelled while its lease was out: reads the order back, closes nothing, and deletes the lease once it lands", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("held");
      void env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5).catch(() => {});
      await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
      await env.lifecycle.cancelOrder(hostId, choice.order.id);
      env.crash();
      await vi.waitFor(() =>
        expect(env.status()?.lastError?.message).toContain("Cancelled. Daintree closes the order")
      );
      expect(env.api.sent).toEqual([`lease ${choice.order.id}`, `read ${choice.order.id}`]);
      // The lease the provider still held lands before the order has read as open for long.
      env.api.answerLease("accept");
      env.clock.at += 61_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(env.api.deleted).toEqual([`lease-${choice.order.id}`]));
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.api.closeOrder).not.toHaveBeenCalled();
      expect(env.api.closedDuringLease).toEqual([]);
      expect(env.status()?.lastError?.message).toContain("leased just before the cancel");
    });

    it("keeps a host whose lease may still land when it is deleted, and deletes it once the order settles", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("hang");
      void env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5).catch(() => {});
      await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
      env.crash();
      await vi.waitFor(() => expect(env.api.readOrder).toHaveBeenCalledTimes(1));
      await expect(env.lifecycle.deleteMachine(hostId, null)).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        userMessage: expect.stringContaining("can't delete the host yet"),
      });
      expect(env.hosts.map((host) => host.id)).toEqual([hostId]);
      expect(env.api.closeOrder).not.toHaveBeenCalled();
      env.clock.at += 61_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.api.orders.get(choice.order.id)?.state).toBe("closed");
      await env.lifecycle.deleteMachine(hostId, null);
      expect(env.hosts).toEqual([]);
    });

    it("deleting the host while its lease is out, then quitting: the next run deletes what the lease made", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("held");
      void env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5).catch(() => {});
      await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
      void env.lifecycle.deleteMachine(hostId, null).catch(() => {});
      await vi.waitFor(() => expect(env.store.createOrders()).toMatchObject([{ cancelled: true }]));
      env.crash();
      env.api.answerLease("accept");
      env.clock.at += 61_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(env.api.deleted).toEqual([`lease-${choice.order.id}`]));
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.api.machines.size).toBe(0);
      expect(env.api.closeOrder).not.toHaveBeenCalled();
    });

    it("after a lease was sent that never landed: keeps the order, says so, and closes it once cancelled", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("hang");
      void env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5).catch(() => {});
      await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
      env.crash();
      await vi.waitFor(() =>
        expect(env.status()?.lastError).toMatchObject({
          code: "outcome-unknown",
          message: expect.stringContaining("Cancel closes the order instead"),
        })
      );
      expect(env.api.closeOrder).not.toHaveBeenCalled();
      expect(env.api.orders.get(choice.order.id)?.state).toBe("open");
      // Cancelled just after this run's first read: the close waits until the order has read as
      // open, nothing leased, for a while, in case the lease the last run sent is still landing.
      await env.lifecycle.cancelOrder(hostId, choice.order.id);
      await vi.waitFor(() =>
        expect(env.status()?.lastError?.message).toContain("Cancelled. Daintree closes the order")
      );
      expect(env.api.closeOrder).not.toHaveBeenCalled();
      // Not yet after half a minute, read again on a pass of its own.
      env.clock.at += 30_000;
      await env.lifecycle.cancelOrder(hostId, choice.order.id);
      await vi.waitFor(() => expect(env.api.readOrder).toHaveBeenCalledTimes(3));
      expect(env.api.closeOrder).not.toHaveBeenCalled();
      env.clock.at += 31_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
      expect(env.api.sent.slice(-2)).toEqual([
        `read ${choice.order.id}`,
        `close ${choice.order.id}`,
      ]);
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

    it("deleting the host while a lease is out waits for it, then deletes the machine it made", async () => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a")];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("held");
      void env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.5).catch(() => {});
      await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
      const removed = env.lifecycle.deleteMachine(hostId, null);
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Nothing is sent for the order, and the host stays, while the lease is out.
      expect(env.api.sent).toEqual([`lease ${choice.order.id}`]);
      expect(env.hosts.map((host) => host.id)).toEqual([hostId]);
      env.api.answerLease("accept");
      await removed;
      expect(env.api.deleted).toEqual([`lease-${choice.order.id}`]);
      expect(env.api.closedDuringLease).toEqual([]);
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

describe("a leased machine's price (#18233)", () => {
  const statusOf = (env: Env, hostId: string) =>
    env.lifecycle.statuses().find((status) => status.hostId === hostId);

  /** A host's create from Settings, by name, so one account can hold several. */
  async function createNamed(env: Env, name: string): Promise<string> {
    const { hostId } = await env.lifecycle.create({
      accountId: env.account.id,
      name,
      machineType: "default",
      lifetimeHours: null,
    });
    return hostId;
  }

  async function choiceFor(env: Env, hostId: string) {
    await vi.waitFor(() => {
      const status = statusOf(env, hostId);
      expect(status?.operation).toBeNull();
      expect(typeof status?.pendingCreate?.offersReadAt).toBe("number");
    });
    return statusOf(env, hostId)!.pendingCreate!;
  }

  async function runningOn(env: Env, hostId: string) {
    await vi.waitFor(() => {
      const status = statusOf(env, hostId);
      expect(status?.machine).toBe("running");
      expect(status?.operation).toBeNull();
    });
    return statusOf(env, hostId)!;
  }

  /** Every hosts write that first gave a binding its machine, by machine. */
  function firstBoundWrites(env: Env): Map<string, Record<string, unknown>> {
    const firsts = new Map<string, Record<string, unknown>>();
    const set = env.saved.set.bind(env.saved);
    env.saved.set = (key: string, value: unknown) => {
      if (key === "cloudHosts") {
        const bindings = (value as { bindings?: Record<string, unknown>[] }).bindings ?? [];
        for (const binding of bindings) {
          const resourceId = binding.resourceId;
          if (typeof resourceId === "string" && !firsts.has(resourceId)) {
            firsts.set(resourceId, structuredClone(binding));
          }
        }
      }
      return set(key, value);
    };
    return firsts;
  }

  it("prices two machines of one size at the rates they were leased at, across a restart", async () => {
    const env = await offerCloud();
    const firsts = firstBoundWrites(env);
    // The catalog lists the size at its own rate, which neither lease paid.
    await env.accounts.catalog(env.account.id);
    env.api.offersOnPlace = [offer("cheap", 0.3), offer("dear", 0.7)];
    const first = await createNamed(env, "build");
    const firstChoice = await choiceFor(env, first);
    await env.lifecycle.chooseOffer(first, firstChoice.order.id, "cheap", 0.3);
    const second = await createNamed(env, "build-2");
    const secondChoice = await choiceFor(env, second);
    await env.lifecycle.chooseOffer(second, secondChoice.order.id, "dear", 0.7);

    expect(await runningOn(env, first)).toMatchObject({
      machineType: "default",
      hourlyDollars: 0.3,
    });
    expect(await runningOn(env, second)).toMatchObject({
      machineType: "default",
      hourlyDollars: 0.7,
    });
    // The rate went out in the write that bound each machine, so no restart finds one without it.
    for (const [choice, hourlyDollars] of [
      [firstChoice, 0.3],
      [secondChoice, 0.7],
    ] as const) {
      const resourceId = `lease-${choice.order.id}`;
      expect(firsts.get(resourceId)?.leaseRate).toEqual({ resourceId, hourlyDollars });
    }

    env.crash();
    await env.accounts.catalog(env.account.id);
    expect(statusOf(env, first)?.hourlyDollars).toBe(0.3);
    expect(statusOf(env, second)?.hourlyDollars).toBe(0.7);
  });

  it("keeps the rate of a lease whose answer was lost, found by reading its order", async () => {
    const env = await offerCloud();
    await env.accounts.catalog(env.account.id);
    env.api.offersOnPlace = [offer("a", 0.3), offer("b", 0.8)];
    const hostId = await env.create();
    const choice = await env.awaitChoice();
    // The first choice is turned down, so the rate that holds is the second's.
    env.api.plans.lease.push("refused", "lost");
    await expect(
      env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.3)
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(env.store.createOrders()).toMatchObject([{ state: "open" }]);
    await env.lifecycle.chooseOffer(hostId, choice.order.id, "b", 0.8);
    expect(await runningOn(env, hostId)).toMatchObject({
      resourceId: `lease-${choice.order.id}`,
      hourlyDollars: 0.8,
    });
    expect(env.api.leaseOffer).toHaveBeenCalledTimes(2);
  });

  it.each([0.25, 0])(
    "keeps the rate of a lease sent just before a crash, bound by the next run ($%s an hour)",
    async (rate) => {
      const env = await offerCloud();
      env.api.offersOnPlace = [offer("a", rate)];
      const hostId = await env.create();
      const choice = await env.awaitChoice();
      env.api.plans.lease.push("hang-commit");
      void env.lifecycle.chooseOffer(hostId, choice.order.id, "a", rate).catch(() => {});
      await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
      env.crash();
      await env.accounts.catalog(env.account.id);
      await vi.waitFor(() => expect(env.status()?.resourceId).toBe(`lease-${choice.order.id}`));
      expect(env.status()?.hourlyDollars).toBe(rate);
    }
  );

  it("learns a lease's rate from a later close of its order, and never replaces one it knows", async () => {
    const env = await offerCloud();
    await env.accounts.catalog(env.account.id);
    env.api.offersOnPlace = [offer("a", 0.45)];
    const hostId = await env.create();
    const choice = await env.awaitChoice();
    const resourceId = `lease-${choice.order.id}`;
    // The lease's answer is lost, and the read that binds the machine can't say its rate.
    env.api.plans.lease.push("lost");
    env.api.reportsLeaseRate = false;
    await env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.45);
    expect(await runningOn(env, hostId)).toMatchObject({ resourceId, hourlyDollars: null });
    expect(env.api.closeOrder).not.toHaveBeenCalled();
    const owed = { ...env.api.storedAtSend[1]![0]!, state: "close" as const, offerId: null };

    // A crash after the bind, before the order was struck off: the next run closes it again.
    env.store.putCreateOrder(owed);
    env.api.reportsLeaseRate = true;
    env.crash();
    await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
    expect(env.status()).toMatchObject({ resourceId, hourlyDollars: 0.45 });

    // Once known, a later answer about the same lease changes nothing.
    env.store.putCreateOrder(owed);
    env.api.orders.get(choice.order.id)!.leasedAt = 0.9;
    env.crash();
    await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
    expect(env.status()).toMatchObject({ resourceId, hourlyDollars: 0.45 });
    expect(env.api.leaseOffer).toHaveBeenCalledTimes(1);
  });

  it("prices a lease that landed just before a cancel at its rate until it is deleted", async () => {
    const env = await offerCloud();
    await env.accounts.catalog(env.account.id);
    env.api.offersOnPlace = [offer("a", 0.45)];
    const hostId = await env.create();
    const choice = await env.awaitChoice();
    env.api.plans.lease.push("held");
    void env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.45).catch(() => {});
    await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
    await env.lifecycle.cancelOrder(hostId, choice.order.id);
    let atDelete: ReturnType<typeof statusOf>;
    env.api.beforeDelete = () => (atDelete = statusOf(env, hostId));
    env.api.answerLease("accept");
    await vi.waitFor(() => expect(env.api.deleted).toEqual([`lease-${choice.order.id}`]));
    expect(atDelete).toMatchObject({ resourceId: `lease-${choice.order.id}`, hourlyDollars: 0.45 });
  });

  it("prices a lease made elsewhere at the rate a read of its order reports, not the one Daintree asked for", async () => {
    const env = await offerCloud();
    env.api.offersOnPlace = [offer("a", 0.3)];
    const hostId = await env.create();
    const choice = await env.awaitChoice();
    // Daintree's lease is still out when it quits; one made in the provider's console at
    // another rate lands meanwhile.
    env.api.plans.lease.push("held");
    void env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.3).catch(() => {});
    await vi.waitFor(() => expect(env.api.leaseOffer).toHaveBeenCalledTimes(1));
    env.api.leaseElsewhere(choice.order.id, 0.9);
    env.crash();
    await vi.waitFor(() => expect(env.store.createOrders()).toEqual([]));
    expect(statusOf(env, hostId)).toMatchObject({
      resourceId: `lease-${choice.order.id}`,
      hourlyDollars: 0.9,
    });
    expect(env.api.readOrder).toHaveBeenCalledTimes(1);
    expect(env.api.closeOrder).not.toHaveBeenCalled();
  });

  it("shows no price for a lease found by a read of its order that can't say its rate", async () => {
    const env = await offerCloud();
    await env.accounts.catalog(env.account.id);
    env.api.reportsLeaseRate = false;
    env.api.offersOnPlace = [offer("a", 0.3)];
    const hostId = await env.create();
    const choice = await env.awaitChoice();
    env.api.plans.lease.push("lost");
    await env.lifecycle.chooseOffer(hostId, choice.order.id, "a", 0.3);
    expect(await runningOn(env, hostId)).toMatchObject({
      resourceId: `lease-${choice.order.id}`,
      hourlyDollars: null,
    });
    expect(env.api.closeOrder).not.toHaveBeenCalled();
  });

  it("shows no price for a machine whose lease rate this device never saw", async () => {
    const env = await offerCloud();
    await env.accounts.catalog(env.account.id);
    env.api.machines.set("dseq-elsewhere", machine("dseq-elsewhere", {}));
    const { hostId } = await env.lifecycle.importMachine({
      accountId: env.account.id,
      resourceId: "dseq-elsewhere",
      name: "imported",
    });
    expect(statusOf(env, hostId)).toMatchObject({ machineType: "default", hourlyDollars: null });
  });
});
