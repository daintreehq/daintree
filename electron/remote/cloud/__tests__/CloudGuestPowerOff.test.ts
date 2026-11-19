// @vitest-environment node
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { AppError } from "../../../utils/errorTypes.js";
import { GuestPowerOffKeeper } from "../../host/GuestPowerOffKeeper.js";
import type { GuestPowerOffSystem } from "../../host/guestPowerOffSystem.js";
import type { LinkSession } from "../../link/session.js";
import { CloudGuestPowerOff } from "../CloudGuestPowerOff.js";
import { CloudHostStore, type CloudHostsValue } from "../CloudHostStore.js";
import {
  GUEST_POWER_OFF_METHOD,
  GuestPowerOffRequestSchema,
  type GuestPowerOffTarget,
} from "../machineKeeperLink.js";
import type { CloudProvider, GuestPowerOffCheck } from "../provider.js";

const MINUTE = 60_000;
const ACCOUNT = "ca_abcdefgh";
const BINDING = "cb_abcdefgh";
const HOST = "build";
const RESOURCE = "eu-west-1/i-0abc0000000000001";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const TARGET: GuestPowerOffTarget = {
  provider: "aws",
  accountId: "123456789012",
  region: "eu-west-1",
  instanceId: "i-0abc0000000000001",
};

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function setup(options: { guest?: boolean } = {}) {
  const clock = { now: Date.parse("2026-11-18T09:00:00Z") };
  let backendValue: unknown;
  const store = new CloudHostStore({
    get: () => backendValue,
    set: (_key: "cloudHosts", value: CloudHostsValue) => {
      backendValue = JSON.parse(JSON.stringify(value));
    },
  });
  store.putAccount({
    id: ACCOUNT,
    providerId: "aws",
    displayName: "Work",
    identity: "arn:aws:iam::123456789012:user/dev",
    scope: { kind: "account", id: "123456789012", name: "123456789012" },
    apiUrl: "https://amazonaws.com",
    keyHint: "MPLE",
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
    providerId: "aws",
    resourceId: RESOURCE,
    ownership: "created-by-daintree",
    createdFor: null,
    worktreeCleanup: null,
    provisioning: null,
    creation: null,
    lifetimeSeconds: null,
    intent: null,
    observation: null,
    access: null,
    trustedHostKey: null,
    offeredHostKey: null,
    lastError: null,
    createdAt: 0,
  });

  const check: Mock<(credentials: unknown, resourceId: string) => Promise<GuestPowerOffCheck>> =
    vi.fn(async () => ({ eligible: true as const, target: TARGET }));
  const provider = {
    id: "aws",
    ...(options.guest === false ? {} : { checkGuestPowerOff: check }),
  } as unknown as CloudProvider;
  const credentials = {
    values: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: SECRET, region: "eu-west-1" },
    scopeId: "123456789012",
    apiUrl: "https://amazonaws.com",
  };
  const accounts = {
    provider: () => provider,
    providerUnavailable: () => null,
    credentials: vi.fn(async () => credentials),
  };

  // The machine's own host, answering as its handler would.
  const system = {
    unsupported: () => null,
    verifyIdentity: vi.fn(async () => ({ ok: true as const })),
    probePowerOff: vi.fn(async () => null as string | null),
    preparePowerOff: vi.fn(async () => async () => ({ kind: "accepted" as const })),
    bootId: async () => "boot-1",
    loadArm: async () => null,
    saveArm: vi.fn(async (_arm: unknown) => {}),
  } satisfies GuestPowerOffSystem;
  const keeper = new GuestPowerOffKeeper({
    idle: {
      observation: () => ({ idleAfterMinutes: 30, lastWorkAt: 0, busy: true, idleEndsAt: null }),
      checkFresh: async () => null,
      mayClaim: () => false,
      tryClaim: (_reading: number | null): _reading is number => false,
      noteWork: () => {},
      noteWorkIfCurrent: () => {},
    },
    system,
    now: () => clock.now,
  });
  disposers.push(() => keeper.dispose());
  const sent: unknown[] = [];
  let hostKnowsMethod = true;
  const answer = async (method: string, payload: unknown): Promise<unknown> => {
    if (method === GUEST_POWER_OFF_METHOD && hostKnowsMethod) {
      sent.push(payload);
      return keeper.set(GuestPowerOffRequestSchema.parse(payload));
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
  const guest = new CloudGuestPowerOff({
    store,
    accounts: accounts as never,
    hosts,
    sessionFor: (hostId) => (hostId === HOST ? session.link : null),
    changed,
    now: () => clock.now,
  });
  disposers.push(() => guest.dispose());
  return {
    guest,
    store,
    keeper,
    system,
    check,
    accounts,
    clock,
    sent,
    changed,
    oldHost() {
      hostKnowsMethod = false;
    },
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
  };
}

describe("CloudGuestPowerOff (#17362)", () => {
  it("checks a linked machine at its provider, then tells its host only which machine it is", async () => {
    const env = setup();
    await env.guest.arm(HOST, env.session);
    expect(env.check).toHaveBeenCalledWith(
      await env.accounts.credentials.mock.results[0]!.value,
      RESOURCE
    );
    expect(env.sent).toEqual([{ target: TARGET, enabled: true }]);
    expect(JSON.stringify(env.sent)).not.toContain(SECRET);
    expect(JSON.stringify(env.sent)).not.toContain("AKIA");
    expect(env.keeper.status()).toEqual({ armed: true, problem: null });
    expect(env.guest.problemFor(BINDING)).toBeNull();
  });

  it("asks nothing of a provider whose machines can't power themselves off", async () => {
    const env = setup({ guest: false });
    await env.guest.arm(HOST, env.session);
    await env.guest.tick();
    expect(env.call).not.toHaveBeenCalled();
    expect(env.accounts.credentials).not.toHaveBeenCalled();
  });

  it("takes the permission back once the provider says a power-off would no longer keep the disk", async () => {
    const env = setup();
    await env.guest.arm(HOST, env.session);
    expect(env.keeper.status().armed).toBe(true);
    env.check.mockResolvedValue({
      eligible: false,
      target: TARGET,
      problem: "It's set to terminate when its own OS shuts down.",
    });
    env.clock.now += 31 * MINUTE;
    await env.guest.tick();
    expect(env.sent.at(-1)).toEqual({ target: TARGET, enabled: false });
    expect(env.keeper.status().armed).toBe(false);
    expect(env.guest.problemFor(BINDING)).toBe(
      "This machine can't stop itself when idle: It's set to terminate when its own OS shuts down."
    );
    expect(env.changed).toHaveBeenCalled();
  });

  it("says when the host is too old to know the call", async () => {
    const env = setup();
    env.oldHost();
    await env.guest.arm(HOST, env.session);
    expect(env.guest.problemFor(BINDING)).toMatch(/too old/);
  });

  it("shows the host's own reason for refusing, and asks again later", async () => {
    const env = setup();
    env.system.probePowerOff.mockResolvedValueOnce("Needs a password to power off.");
    await env.guest.arm(HOST, env.session);
    expect(env.guest.problemFor(BINDING)).toBe("Needs a password to power off.");
    await env.guest.tick();
    expect(env.sent).toHaveLength(1);
    env.clock.now += 6 * MINUTE;
    await env.guest.tick();
    expect(env.sent).toHaveLength(2);
    expect(env.guest.problemFor(BINDING)).toBeNull();
  });

  it("changes nothing when the provider can't be asked, and tries again after a pause", async () => {
    const env = setup();
    await env.guest.arm(HOST, env.session);
    env.check.mockRejectedValueOnce(new Error("network"));
    env.clock.now += 31 * MINUTE;
    await env.guest.tick();
    expect(env.check).toHaveBeenCalledTimes(2);
    expect(env.keeper.status()).toEqual({ armed: true, problem: null });
    expect(env.guest.problemFor(BINDING)).toBeNull();
    // The pause holds although the last good check is long past.
    env.clock.now += 4 * MINUTE;
    await env.guest.tick();
    expect(env.check).toHaveBeenCalledTimes(2);
    env.clock.now += 2 * MINUTE;
    await env.guest.tick();
    expect(env.check).toHaveBeenCalledTimes(3);
  });

  it("pauses after a first check that fails, rather than asking every pass", async () => {
    const env = setup();
    env.check.mockRejectedValueOnce(new Error("network"));
    await env.guest.arm(HOST, env.session);
    env.clock.now += MINUTE;
    await env.guest.tick();
    expect(env.check).toHaveBeenCalledTimes(1);
    env.clock.now += 5 * MINUTE;
    await env.guest.tick();
    expect(env.check).toHaveBeenCalledTimes(2);
    expect(env.sent).toEqual([{ target: TARGET, enabled: true }]);
  });

  it("sends a take-back again soon when it may not have arrived", async () => {
    const env = setup();
    await env.guest.arm(HOST, env.session);
    env.check.mockResolvedValue({ eligible: false, target: TARGET, problem: "Not EBS." });
    env.call.mockImplementationOnce(async () => {
      throw new Error("timed out");
    });
    env.clock.now += 31 * MINUTE;
    await env.guest.tick();
    expect(env.keeper.status().armed).toBe(true);
    env.clock.now += 6 * MINUTE;
    await env.guest.tick();
    expect(env.sent.at(-1)).toEqual({ target: TARGET, enabled: false });
    expect(env.keeper.status().armed).toBe(false);
  });

  it("says when the host couldn't make a take-back last, and sends it again soon", async () => {
    const env = setup();
    await env.guest.arm(HOST, env.session);
    env.check.mockResolvedValue({ eligible: false, target: TARGET, problem: "Not EBS." });
    env.system.saveArm.mockRejectedValueOnce(new Error("EROFS"));
    env.clock.now += 31 * MINUTE;
    await env.guest.tick();
    expect(env.keeper.status().armed).toBe(false);
    expect(env.guest.problemFor(BINDING)).toMatch(/Not EBS\. .*couldn't remove/);
    env.clock.now += 6 * MINUTE;
    await env.guest.tick();
    expect(
      env.sent.filter((sent) => (sent as { enabled: boolean }).enabled === false)
    ).toHaveLength(2);
    expect(env.guest.problemFor(BINDING)).toBe(
      "This machine can't stop itself when idle: Not EBS."
    );
  });

  it("keeps saying a take-back didn't last until the host says it did, and ignores a replaced link's reply", async () => {
    const env = setup();
    await env.guest.arm(HOST, env.session);
    env.check.mockResolvedValue({ eligible: false, target: TARGET, problem: "Not EBS." });
    env.system.saveArm.mockRejectedValueOnce(new Error("EROFS"));
    env.clock.now += 31 * MINUTE;
    await env.guest.tick();
    expect(env.guest.problemFor(BINDING)).toMatch(/couldn't remove/);
    // The resend is lost: the warning stays.
    env.call.mockImplementationOnce(async () => {
      throw new Error("timed out");
    });
    env.clock.now += 6 * MINUTE;
    await env.guest.tick();
    expect(env.guest.problemFor(BINDING)).toMatch(/couldn't remove/);
    // A reply on a link since replaced settles nothing.
    let answer: ((value: unknown) => void) | null = null;
    env.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    env.clock.now += 6 * MINUTE;
    const ticking = env.guest.tick();
    await vi.waitFor(() => expect(answer).not.toBeNull());
    env.newSession();
    answer!({ armed: false, problem: null });
    await ticking;
    expect(env.guest.problemFor(BINDING)).toMatch(/couldn't remove/);
    // The new link opening asks again, and its host says it's gone.
    await env.guest.arm(HOST, env.session);
    expect(env.guest.problemFor(BINDING)).toBe(
      "This machine can't stop itself when idle: Not EBS."
    );
  });

  it("never shows a replaced link's late refusal", async () => {
    const env = setup();
    const first = env.session;
    let refuse: (() => void) | null = null;
    env.call.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = () => reject(new AppError({ code: "UNSUPPORTED", message: "old" }));
        })
    );
    const armed = env.guest.arm(HOST, first);
    await vi.waitFor(() => expect(refuse).not.toBeNull());
    const second = env.newSession();
    refuse!();
    await armed;
    expect(env.guest.problemFor(BINDING)).toBeNull();
    await env.guest.arm(HOST, second);
    expect(env.keeper.status().armed).toBe(true);
  });

  it("sends nothing over a link replaced while the provider was asked", async () => {
    const env = setup();
    const first = env.session;
    const firstCall = env.call;
    let release: (() => void) | null = null;
    env.check.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ eligible: true, target: TARGET });
        })
    );
    const armed = env.guest.arm(HOST, first);
    await vi.waitFor(() => expect(release).not.toBeNull());
    const second = env.newSession();
    env.guest.sessionOpened(HOST, second);
    release!();
    await armed;
    expect(firstCall).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(env.call).toHaveBeenCalledTimes(1));
  });

  it("checks a linked machine again every half hour, and forgets a removed binding's reason", async () => {
    const env = setup();
    await env.guest.arm(HOST, env.session);
    env.clock.now += 10 * MINUTE;
    await env.guest.tick();
    expect(env.check).toHaveBeenCalledTimes(1);
    env.clock.now += 21 * MINUTE;
    await env.guest.tick();
    expect(env.check).toHaveBeenCalledTimes(2);

    env.check.mockResolvedValue({ eligible: false, target: TARGET, problem: "Not EBS." });
    env.clock.now += 31 * MINUTE;
    await env.guest.tick();
    expect(env.guest.problemFor(BINDING)).not.toBeNull();
    env.store.removeBinding(BINDING);
    await env.guest.tick();
    expect(env.guest.problemFor(BINDING)).toBeNull();
  });

  it("forgets a removed binding's reason when asked, with no tick to come", async () => {
    const env = setup();
    env.check.mockResolvedValue({ eligible: false, target: TARGET, problem: "Not EBS." });
    await env.guest.arm(HOST, env.session);
    expect(env.guest.problemFor(BINDING)).not.toBeNull();
    env.guest.forgetRemoved();
    expect(env.guest.problemFor(BINDING)).not.toBeNull();
    env.store.removeBinding(BINDING);
    env.guest.forgetRemoved();
    expect(env.guest.problemFor(BINDING)).toBeNull();
  });

  it("keeps no retry for an arm that failed after its binding was removed", async () => {
    const env = setup();
    let fail: (() => void) | null = null;
    env.check.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error("provider unreachable"));
        })
    );
    const armed = env.guest.arm(HOST, env.session);
    await vi.waitFor(() => expect(fail).not.toBeNull());
    env.store.removeBinding(BINDING);
    fail!();
    await armed;
    const retryAt = (env.guest as unknown as { retryAt: Map<string, number> }).retryAt;
    expect(retryAt.has(BINDING)).toBe(false);
  });
});
