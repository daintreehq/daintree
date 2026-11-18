// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { AppError } from "../../../utils/errorTypes.js";
import { HostIdleTracker } from "../../host/HostIdleTracker.js";
import { MachineKeeper } from "../../host/MachineKeeper.js";
import type { LinkSession } from "../../link/session.js";
import { BoatApiError } from "../boat/BoatClient.js";
import { BoatProvider } from "../boat/BoatProvider.js";
import { CloudHostStore, type CloudHostsValue } from "../CloudHostStore.js";
import { CloudMachineKeys, MACHINE_KEY_TTL_DAYS } from "../CloudMachineKeys.js";
import { MachineKeeperLinkMethod, MachineKeeperArmSchema } from "../machineKeeperLink.js";
import type { Mock } from "vitest";
import { UnusableMachineKeyError, type CloudProvider, type MachineKeyIssuer } from "../provider.js";

const DAY = 24 * 60 * 60_000;
const ACCOUNT = "ca_abcdefgh";
const BINDING = "cb_abcdefgh";
const HOST = "build";
const SANDBOX = "bx_23456789";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function setup() {
  const clock = { now: Date.parse("2026-11-18T09:00:00Z") };
  let backendValue: unknown;
  const backend = {
    get: () => backendValue,
    set: (_key: "cloudHosts", value: CloudHostsValue) => {
      backendValue = JSON.parse(JSON.stringify(value));
    },
  };
  const store = new CloudHostStore(backend);
  store.putAccount({
    id: ACCOUNT,
    providerId: "boat",
    displayName: "Personal",
    identity: "octocat",
    scope: { kind: "personal", id: "personal", name: "Personal" },
    apiUrl: "https://boat.test/api/v1",
    keyHint: "abcd",
    credentialRevision: null,
    addedAt: 0,
    validation: { status: "unknown", checkedAt: null, detail: null },
    lastProvisioning: null,
    pluginProvider: null,
  });
  store.putBinding({
    id: BINDING,
    hostId: HOST,
    accountId: ACCOUNT,
    providerId: "boat",
    resourceId: SANDBOX,
    ownership: "imported",
    createdFor: null,
    worktreeCleanup: null,
    provisioning: null,
    creation: null,
    lifetimeSeconds: 7200,
    intent: null,
    observation: null,
    access: null,
    trustedHostKey: null,
    offeredHostKey: null,
    lastError: null,
    createdAt: 0,
  });

  let issued = 0;
  const machineKeys = {
    issue: vi.fn<MachineKeyIssuer["issue"]>(async () => {
      issued += 1;
      return {
        keyId: `sak_${issued}`,
        secret: `boat_live_machinesecret${issued}`,
        expiresAt: clock.now + MACHINE_KEY_TTL_DAYS * DAY,
      };
    }),
    revoke: vi.fn<MachineKeyIssuer["revoke"]>(async () => {}),
    findByName: vi.fn<MachineKeyIssuer["findByName"]>(async () => []),
  };
  const real = new BoatProvider(() => {
    throw new Error("unused");
  });
  const provider = {
    id: "boat",
    info: (platform: NodeJS.Platform) => real.info(platform),
    describeError: (error: unknown) => real.describeError(error),
    machineKeys,
  } as unknown as CloudProvider;
  const credentials = {
    values: { apiKey: "boat_live_account" },
    scopeId: "personal",
    apiUrl: "https://boat.test/api/v1",
  };
  const accounts = {
    provider: () => provider,
    providerUnavailable: () => null,
    credentials: vi.fn(async () => credentials),
  };

  // The machine's own host, answering this Shell's calls as its handlers would.
  const tracker = new HostIdleTracker({
    read: async () => ({ agents: { active: 1, unreadable: 0 }, shellViews: false }),
    idleAfterMinutes: () => 30,
  });
  const keeper = new MachineKeeper({
    idle: tracker,
    now: () => clock.now,
    tickMs: 10 * DAY,
    driverFor: () => ({
      inspect: vi.fn(async () => {
        throw new Error("not reached");
      }),
      renew: vi.fn(),
      stop: vi.fn(),
      failure: () => ({ kind: "retry" as const }),
    }),
  });
  disposers.push(() => {
    keeper.dispose();
    tracker.dispose();
  });
  const delivered: unknown[] = [];
  const answer = async (method: string, payload: unknown): Promise<unknown> => {
    if (method === MachineKeeperLinkMethod.STATUS) return keeper.status();
    if (method === MachineKeeperLinkMethod.ARM) {
      delivered.push(payload);
      return keeper.arm(MachineKeeperArmSchema.parse(payload));
    }
    throw new AppError({ code: "UNSUPPORTED", message: `Unknown method: ${method}` });
  };
  const makeSession = () => {
    const call: Mock<(method: string, payload: unknown) => Promise<unknown>> = vi.fn(answer);
    return { link: { isOpen: true, call } as unknown as LinkSession, call };
  };
  let session = makeSession();
  const hosts = {
    get: (hostId: string) =>
      hostId === HOST
        ? ({
            id: HOST,
            name: HOST,
            connection: { kind: "cloud", bindingId: BINDING },
          } as HostDescriptor)
        : null,
  };
  const changed = vi.fn();
  const keys = new CloudMachineKeys({
    store,
    accounts: accounts as never,
    hosts,
    sessionFor: (hostId) => (hostId === HOST ? session.link : null),
    changed,
    now: () => clock.now,
  });
  disposers.push(() => keys.dispose());
  return {
    keys,
    store,
    keeper,
    machineKeys,
    accounts,
    clock,
    delivered,
    changed,
    answer,
    get session() {
      return session.link;
    },
    get call() {
      return session.call;
    },
    newSession() {
      session = makeSession();
      return session.link;
    },
    raw: () => JSON.stringify(backendValue),
  };
}

describe("CloudMachineKeys", () => {
  it("gives a linked machine a key limited to it, over its own link, and keeps no secret", async () => {
    const env = setup();
    let recordedFirst: unknown = null;
    env.machineKeys.issue.mockImplementationOnce(async (_credentials, resourceId, request) => {
      recordedFirst = env.store.machineKeys()[0];
      expect(resourceId).toBe(SANDBOX);
      expect(request.ttlDays).toBe(MACHINE_KEY_TTL_DAYS);
      return {
        keyId: "sak_1",
        secret: "boat_live_machinesecret",
        expiresAt: env.clock.now + 30 * DAY,
      };
    });
    let atDelivery: unknown = null;
    env.call.mockImplementation(async (method: string, payload: unknown) => {
      if (method === MachineKeeperLinkMethod.ARM) atDelivery = env.store.machineKeys()[0];
      return env.answer(method, payload);
    });
    await env.keys.arm(HOST, env.session);

    // Written down before Boat was asked, under the name it is created with,
    // and its id kept before the secret went anywhere.
    expect(atDelivery).toMatchObject({ state: "delivering", keyId: "sak_1" });
    expect(recordedFirst).toMatchObject({ state: "issuing", keyId: null, resourceId: SANDBOX });
    const [record] = env.store.machineKeys();
    expect(record).toMatchObject({ state: "active", keyId: "sak_1", bindingId: BINDING });
    expect(env.machineKeys.issue.mock.calls[0]![2].name).toBe(record!.name);
    expect(env.keeper.status()).toMatchObject({ grantId: record!.id, resourceId: SANDBOX });
    expect(env.delivered).toEqual([
      expect.objectContaining({
        resourceId: SANDBOX,
        scope: "personal",
        provider: "boat",
        secret: "boat_live_machinesecret",
      }),
    ]);
    expect(env.raw()).not.toContain("boat_live_machinesecret");
    expect(env.keys.problemFor(BINDING)).toBeNull();
  });

  it("issues nothing on a reconnect while the machine holds a working key", async () => {
    const env = setup();
    await env.keys.arm(HOST, env.session);
    await env.keys.arm(HOST, env.newSession());
    expect(env.machineKeys.issue).toHaveBeenCalledTimes(1);
    expect(env.store.machineKeys()).toHaveLength(1);
  });

  it("leaves a host too old to take a key as it was, and says so", async () => {
    const env = setup();
    env.call.mockRejectedValueOnce(
      new AppError({ code: "UNSUPPORTED", message: "Unknown method: machine-keeper.status" })
    );
    await env.keys.arm(HOST, env.session);
    expect(env.machineKeys.issue).not.toHaveBeenCalled();
    expect(env.keys.problemFor(BINDING)).toMatch(/too old/);
  });

  it("says why when the account's key can't issue one, and doesn't ask again for the same key", async () => {
    const env = setup();
    env.machineKeys.issue.mockRejectedValue(
      new BoatApiError("forbidden", "missing account.admin", 403, "api_key_action_forbidden", null)
    );
    await env.keys.arm(HOST, env.session);
    expect(env.store.machineKeys()).toEqual([]);
    expect(env.keys.problemFor(BINDING)).toMatch(/can't stop itself when idle/);
    expect(env.changed).toHaveBeenCalled();

    await env.keys.arm(HOST, env.newSession());
    expect(env.machineKeys.issue).toHaveBeenCalledTimes(1);

    // Asked again an hour on, on the same link.
    env.clock.now += 61 * 60_000;
    await env.keys.tick();
    expect(env.machineKeys.issue).toHaveBeenCalledTimes(2);
  });

  it("waits out a failure that may pass, however often the link comes back", async () => {
    const env = setup();
    env.machineKeys.issue.mockRejectedValueOnce(new BoatApiError("server", "x", 500, null, null));
    await env.keys.arm(HOST, env.session);
    await env.keys.arm(HOST, env.newSession());
    await env.keys.arm(HOST, env.newSession());
    expect(env.machineKeys.issue).toHaveBeenCalledTimes(1);
    env.clock.now += 6 * 60_000;
    await env.keys.tick();
    expect(env.machineKeys.issue).toHaveBeenCalledTimes(2);
    expect(env.keeper.status().grantId).not.toBeNull();
  });

  it("replaces a key near its expiry while linked, then revokes the old one", async () => {
    const env = setup();
    await env.keys.arm(HOST, env.session);
    const first = env.store.machineKeys()[0]!;
    // Asked what it holds now and then; a key with time left stays.
    env.clock.now += 31 * 60_000;
    await env.keys.tick();
    expect(env.machineKeys.issue).toHaveBeenCalledTimes(1);
    env.clock.now += (MACHINE_KEY_TTL_DAYS - 5) * DAY;
    await env.keys.tick();
    expect(env.machineKeys.issue).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(env.machineKeys.revoke).toHaveBeenCalledWith(expect.anything(), first.keyId)
    );
    await vi.waitFor(() => expect(env.store.machineKey(first.id)).toBeNull());
    expect(env.keeper.status().grantId).toBe(env.store.machineKeys()[0]!.id);
  });

  it("revokes the machine's key at the provider when its host is removed", async () => {
    const env = setup();
    await env.keys.arm(HOST, env.session);
    const { keyId } = env.store.machineKeys()[0]!;
    env.store.removeBinding(BINDING);
    expect(env.store.machineKeys()[0]?.state).toBe("revoke");
    await env.keys.revokePending();
    expect(env.machineKeys.revoke).toHaveBeenCalledWith(expect.anything(), keyId);
    expect(env.store.machineKeys()).toEqual([]);
  });

  it("keeps a revoke that failed and tries it again later", async () => {
    const env = setup();
    await env.keys.arm(HOST, env.session);
    env.store.removeBinding(BINDING);
    env.machineKeys.revoke.mockRejectedValueOnce(
      new BoatApiError("network", "down", null, null, null)
    );
    await env.keys.revokePending();
    expect(env.store.machineKeys()).toHaveLength(1);
    // Not hammered: the next pass waits a while.
    await env.keys.revokePending();
    expect(env.machineKeys.revoke).toHaveBeenCalledTimes(1);
    env.clock.now += 6 * 60_000;
    await env.keys.revokePending();
    expect(env.machineKeys.revoke).toHaveBeenCalledTimes(2);
    expect(env.store.machineKeys()).toEqual([]);
  });

  it("finds a key whose create lost its answer by name, and revokes it", async () => {
    const env = setup();
    env.machineKeys.issue.mockRejectedValueOnce(
      new BoatApiError("timeout", "slow", null, null, null)
    );
    let looked: unknown = null;
    // Not listed yet: its create may still land, so it is kept and looked for again.
    env.machineKeys.findByName.mockResolvedValueOnce([]);
    env.machineKeys.findByName.mockImplementationOnce(async (_credentials, name) => {
      looked = env.store.machineKeys().find((key) => key.name === name);
      return ["sak_lost"];
    });
    await env.keys.arm(HOST, env.session);
    await env.keys.revokePending();
    expect(env.machineKeys.findByName).toHaveBeenCalledTimes(1);
    expect(env.store.machineKeys()).toHaveLength(1);
    env.clock.now += 61 * 60_000;
    await env.keys.revokePending();
    expect(looked).toMatchObject({ state: "revoke", keyId: null });
    expect(env.machineKeys.revoke).toHaveBeenCalledWith(expect.anything(), "sak_lost");
    expect(env.store.machineKeys()).toEqual([]);
    expect(env.keeper.status().grantId).toBeNull();
  });

  it("never sends a key down a link that stopped reaching the machine while it was made", async () => {
    const env = setup();
    env.machineKeys.issue.mockImplementationOnce(async () => {
      env.newSession();
      return {
        keyId: "sak_1",
        secret: "boat_live_machinesecret",
        expiresAt: env.clock.now + 30 * DAY,
      };
    });
    const first = env.session;
    await env.keys.arm(HOST, first);
    expect(env.delivered).toEqual([]);
    // Never delivered, and turned off at once.
    await env.keys.revokePending();
    expect(env.machineKeys.revoke).toHaveBeenCalledWith(expect.anything(), "sak_1");
    expect(env.store.machineKeys()).toEqual([]);
  });

  it("leaves a key another device gave the machine alone", async () => {
    const env = setup();
    await env.keeper.arm({
      grantId: "mk_otherdevice",
      provider: "boat",
      apiUrl: "https://boat.test/api/v1",
      scope: "personal",
      resourceId: SANDBOX,
      secret: "boat_live_theirs",
      expiresAt: env.clock.now + 60 * DAY,
    });
    await env.keys.arm(HOST, env.session);
    expect(env.machineKeys.issue).not.toHaveBeenCalled();
    expect(env.keeper.status().grantId).toBe("mk_otherdevice");
  });

  it("settles an arm whose answer was lost by what the machine says it holds next time", async () => {
    const env = setup();
    env.call.mockImplementation(async (method: string, payload: unknown) => {
      const answer = await env.answer(method, payload);
      if (method === MachineKeeperLinkMethod.ARM) {
        throw new AppError({ code: "OUTCOME_UNKNOWN", message: "link dropped" });
      }
      return answer;
    });
    await env.keys.arm(HOST, env.session);
    expect(env.store.machineKeys()[0]?.state).toBe("delivering");

    await env.keys.arm(HOST, env.newSession());
    expect(env.store.machineKeys()[0]?.state).toBe("active");
    expect(env.machineKeys.issue).toHaveBeenCalledTimes(1);
  });

  it("revokes what a removed account's machines hold before its key goes, and refuses while one may still work", async () => {
    const env = setup();
    await env.keys.arm(HOST, env.session);
    env.store.removeBinding(BINDING);
    env.machineKeys.revoke.mockRejectedValue(new BoatApiError("server", "x", 500, null, null));
    await env.keys.revokePending();
    // Backing off, yet the account's removal tries again at once, and says it couldn't.
    await expect(env.keys.settleAccount(ACCOUNT)).rejects.toMatchObject({
      userMessage: expect.stringMatching(/couldn't yet revoke/),
    });
    expect(env.machineKeys.revoke).toHaveBeenCalledTimes(2);
    expect(env.store.machineKeys()).toHaveLength(1);

    env.machineKeys.revoke.mockResolvedValue(undefined);
    await expect(env.keys.settleAccount(ACCOUNT)).resolves.toBeUndefined();
    expect(env.store.machineKeys()).toEqual([]);
  });

  it("arms a link that came up while another link's attempt was under way", async () => {
    const env = setup();
    let finish: () => void = () => {};
    env.machineKeys.issue.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              keyId: "sak_old",
              secret: "boat_live_oldsecret",
              expiresAt: env.clock.now + 30 * DAY,
            });
        })
    );
    const first = env.keys.arm(HOST, env.session);
    await vi.waitFor(() => expect(env.machineKeys.issue).toHaveBeenCalledTimes(1));
    const second = env.newSession();
    env.keys.sessionOpened(HOST, second);
    finish();
    await first;
    await vi.waitFor(() => expect(env.keeper.status().grantId).not.toBeNull());
    expect(env.delivered).toHaveLength(1);
    expect(env.delivered[0]).toMatchObject({ secret: "boat_live_machinesecret1" });
    await vi.waitFor(() =>
      expect(env.machineKeys.revoke).toHaveBeenCalledWith(expect.anything(), "sak_old")
    );
  });

  it("takes Boat switching key creation off as a refusal, with nothing to look for", async () => {
    const env = setup();
    env.machineKeys.issue.mockRejectedValueOnce(
      new BoatApiError(
        "no-capacity",
        "Scoped keys aren't on yet",
        503,
        "scoped_api_key_creation_disabled",
        null
      )
    );
    await env.keys.arm(HOST, env.session);
    await env.keys.revokePending();
    expect(env.store.machineKeys()).toEqual([]);
    expect(env.machineKeys.findByName).not.toHaveBeenCalled();
    expect(env.keys.problemFor(BINDING)).toMatch(/isn't issuing API keys/);
  });

  it("revokes a key Boat made other than asked, by its id", async () => {
    const env = setup();
    env.machineKeys.issue.mockRejectedValueOnce(
      new UnusableMachineKeyError(
        "sak_broad",
        env.clock.now + 30 * DAY,
        "Boat issued a key other than the one asked for."
      )
    );
    await env.keys.arm(HOST, env.session);
    await env.keys.revokePending();
    expect(env.delivered).toEqual([]);
    expect(env.machineKeys.revoke).toHaveBeenCalledWith(expect.anything(), "sak_broad");
    expect(env.store.machineKeys()).toEqual([]);
  });

  it("keeps a rejected key's own expiry, and forgets it only once that passes", async () => {
    const env = setup();
    const expiresAt = env.clock.now + 45 * DAY;
    env.machineKeys.issue.mockRejectedValueOnce(
      new UnusableMachineKeyError("sak_long", expiresAt, "Boat issued a key other than asked.")
    );
    env.machineKeys.revoke.mockRejectedValue(new BoatApiError("server", "x", 500, null, null));
    await env.keys.arm(HOST, env.session);
    await env.keys.revokePending();
    expect(env.store.machineKeys()).toEqual([
      expect.objectContaining({ keyId: "sak_long", expiresAt }),
    ]);
    env.clock.now += 40 * DAY;
    await env.keys.revokePending();
    expect(env.store.machineKeys()).toHaveLength(1);
    env.clock.now += 6 * DAY;
    await env.keys.revokePending();
    expect(env.store.machineKeys()).toEqual([]);
  });

  it("keeps trying to revoke a rejected key Boat gave no expiry, past the usual lifetime", async () => {
    const env = setup();
    env.machineKeys.issue.mockRejectedValueOnce(
      new UnusableMachineKeyError("sak_forever", null, "Boat issued a key other than asked.")
    );
    env.machineKeys.revoke.mockRejectedValue(new BoatApiError("server", "x", 500, null, null));
    await env.keys.arm(HOST, env.session);
    await env.keys.revokePending();
    env.clock.now += 40 * DAY;
    await env.keys.revokePending();
    expect(env.store.machineKeys()).toEqual([
      expect.objectContaining({ keyId: "sak_forever", state: "revoke" }),
    ]);
    await expect(env.keys.settleAccount(ACCOUNT)).rejects.toBeInstanceOf(AppError);
  });

  it("says why when the account's own key isn't on this device, and asks Boat for nothing", async () => {
    const env = setup();
    env.accounts.credentials.mockRejectedValueOnce(
      new AppError({
        code: "PERMISSION",
        message: "Cloud account key is missing",
        userMessage: "Personal's API key isn't on this device any more.",
      })
    );
    await env.keys.arm(HOST, env.session);
    expect(env.machineKeys.issue).not.toHaveBeenCalled();
    expect(env.store.machineKeys()).toEqual([]);
    expect(env.keys.problemFor(BINDING)).toMatch(/isn't on this device any more/);
    // Replaced and linked again at once: nothing holds it back.
    await env.keys.arm(HOST, env.newSession());
    expect(env.machineKeys.issue).toHaveBeenCalledTimes(1);
  });
});
