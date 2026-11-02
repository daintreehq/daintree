import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingPairing } from "@daintreehq/decisions-protocol";

vi.mock("electron", () => ({ app: {}, safeStorage: {}, net: {} }));

const relay = vi.hoisted(() => ({
  pending: [] as unknown[],
  pendingPairings: vi.fn(),
  rejectPairing: vi.fn(),
  approveCandidate: vi.fn(),
  createPairingInvite: vi.fn(),
  verifiedDevices: vi.fn(),
  localShortCode: vi.fn(),
  lastFailure: null as null | { reason: string; answered: boolean },
  // The lifetime's key rotations, as OwnerDevices uses them.
  rotate: vi.fn(),
  queue: [] as Array<() => void>,
  holdQueue: false,
}));

vi.mock("@daintreehq/decisions-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@daintreehq/decisions-client")>();
  class RelayClient {
    pendingPairings = relay.pendingPairings;
    rejectPairing = relay.rejectPairing;
  }
  return {
    ...actual,
    RelayClient,
    importIdentity: vi.fn(async () => ({ config: {} })),
    approveCandidate: relay.approveCandidate,
    createPairingInvite: relay.createPairingInvite,
    verifiedDevices: relay.verifiedDevices,
    localShortCode: relay.localShortCode,
  };
});

vi.mock("../relayIdentity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../relayIdentity.js")>();
  return {
    ...actual,
    relayRequests: vi.fn(async () => ({ fetch: vi.fn(), lastFailure: () => relay.lastFailure })),
  };
});

import { RelayError, type StoredIdentity } from "@daintreehq/decisions-client";
import type { KeyRotations } from "../keyRotation.js";
import { OwnerDevices } from "../pairing.js";

const ORIGIN = "https://decisions.example.workers.dev";
const INSTALLATION = "inst_0123456789abcdef";
const DEVICE = "dev_owner_0123456789";

function stored(overrides: Partial<StoredIdentity["config"]> = {}): StoredIdentity {
  return {
    config: { relayOrigin: ORIGIN, installationId: INSTALLATION, deviceId: DEVICE, ...overrides },
    claimed: true,
  } as unknown as StoredIdentity;
}

function candidate(overrides: Partial<PendingPairing> = {}): PendingPairing {
  return {
    pairing_id: "pair_1",
    device_id: "dev_phone_1",
    label: "Greg's iPhone",
    role: "phone",
    signing_pub: "sig",
    exchange_pub: "exch",
    short_code: "482913",
    expires_at: new Date(Date.now() + 240_000).toISOString(),
    ...overrides,
  };
}

/** Steps that take their turn run at once, or wait for `releaseQueue` while it is held. */
const rotations = {
  rotate: (...args: unknown[]) => relay.rotate(...args),
  withCurrentKeys: async <T>(_client: unknown, step: () => Promise<T>): Promise<T> => {
    if (relay.holdQueue) await new Promise<void>((resolve) => relay.queue.push(resolve));
    return step();
  },
} as unknown as KeyRotations;

function releaseQueue(): void {
  relay.holdQueue = false;
  for (const resume of relay.queue.splice(0)) resume();
}

function owner(identity: StoredIdentity | null = stored(), now = () => Date.now()) {
  return new OwnerDevices({
    relayOrigin: ORIGIN,
    installationId: INSTALLATION,
    deviceId: DEVICE,
    keys: { load: vi.fn(async () => identity) },
    rotations,
    now,
  });
}

async function invited(devices: OwnerDevices) {
  relay.createPairingInvite.mockResolvedValueOnce({
    url: `${ORIGIN}/pair#payload`,
    payload: {},
    pairingId: "pair_1",
    expiresAt: Date.now() + 295_000,
  });
  const started = await devices.invite();
  expect(started.result).toBe("started");
}

describe("OwnerDevices", () => {
  beforeEach(() => {
    relay.pending = [];
    relay.lastFailure = null;
    relay.pendingPairings.mockReset().mockImplementation(async () => ({ pending: relay.pending }));
    relay.rejectPairing.mockReset().mockResolvedValue({});
    relay.approveCandidate.mockReset().mockResolvedValue(undefined);
    relay.createPairingInvite.mockReset();
    relay.verifiedDevices.mockReset();
    relay.localShortCode.mockReset().mockResolvedValue("482913");
    relay.rotate.mockReset();
    relay.queue = [];
    relay.holdQueue = false;
  });

  it("shows the code computed from the phone's keys, not the relay's", async () => {
    const devices = owner();
    await invited(devices);
    relay.pending = [candidate({ short_code: "111111" })];
    relay.localShortCode.mockResolvedValueOnce("482913");

    const read = await devices.read("pair_1");

    expect(read).toMatchObject({ state: "responded", code: "482913", label: "Greg's iPhone" });
  });

  it("approves nothing for a code other than the one shown", async () => {
    const devices = owner();
    await invited(devices);
    relay.pending = [candidate()];
    await devices.read("pair_1");

    await expect(devices.approve({ pairingId: "pair_1", code: "000000" })).resolves.toEqual({
      result: "changed",
    });
    expect(relay.approveCandidate).not.toHaveBeenCalled();
  });

  it("rejects the invitation when the relay's code disagrees with the phone's keys", async () => {
    const devices = owner();
    await invited(devices);
    relay.pending = [candidate({ short_code: "111111" })];
    await devices.read("pair_1");

    await expect(devices.approve({ pairingId: "pair_1", code: "482913" })).resolves.toEqual({
      result: "changed",
    });
    expect(relay.approveCandidate).not.toHaveBeenCalled();
    expect(relay.rejectPairing).toHaveBeenCalledWith("pair_1");
  });

  it("approves the candidate it showed once, then forgets the invitation", async () => {
    const devices = owner();
    await invited(devices);
    const shown = candidate();
    relay.pending = [shown];
    await devices.read("pair_1");

    await expect(devices.approve({ pairingId: "pair_1", code: "482913" })).resolves.toEqual({
      result: "paired",
      label: "Greg's iPhone",
    });
    expect(relay.approveCandidate).toHaveBeenCalledWith(expect.anything(), shown);
    await expect(devices.approve({ pairingId: "pair_1", code: "482913" })).resolves.toEqual({
      result: "changed",
    });
    expect(relay.approveCandidate).toHaveBeenCalledTimes(1);
  });

  it("can't approve an invitation once it is declined, whatever the relay answers", async () => {
    const devices = owner();
    await invited(devices);
    relay.pending = [candidate()];
    await devices.read("pair_1");
    relay.rejectPairing.mockRejectedValueOnce(new RelayError("network_error", "network", 0));
    relay.lastFailure = { reason: "dns", answered: false };

    await expect(devices.decline("pair_1")).resolves.toEqual({
      result: "unreachable",
      origin: ORIGIN,
      reason: "dns",
    });
    await expect(devices.approve({ pairingId: "pair_1", code: "482913" })).resolves.toEqual({
      result: "changed",
    });
    expect(relay.approveCandidate).not.toHaveBeenCalled();
  });

  it("reads an answered invitation the relay dropped, with no such device, as expired", async () => {
    const devices = owner();
    await invited(devices);
    relay.pending = [candidate()];
    await devices.read("pair_1");
    relay.pending = [];
    relay.verifiedDevices.mockResolvedValueOnce([]);

    await expect(devices.read("pair_1")).resolves.toEqual({ state: "expired" });
  });

  it("reads a lost approval as paired once the relay lists the phone with the same keys", async () => {
    const devices = owner();
    await invited(devices);
    const shown = candidate();
    relay.pending = [shown];
    await devices.read("pair_1");
    relay.approveCandidate.mockRejectedValueOnce(new RelayError("network_error", "network", 0));
    relay.lastFailure = { reason: "timeout", answered: true };
    await expect(devices.approve({ pairingId: "pair_1", code: "482913" })).resolves.toMatchObject({
      result: "unreachable",
    });
    relay.pending = [];
    relay.verifiedDevices.mockResolvedValueOnce([
      {
        device_id: shown.device_id,
        revoked_at: null,
        cert: { label: "Greg's iPhone", signing_pub: "sig", exchange_pub: "exch" },
      },
    ]);

    await expect(devices.read("pair_1")).resolves.toEqual({
      state: "paired",
      label: "Greg's iPhone",
    });
  });

  it("reads a retried approval the relay already settled as paired when the phone is listed", async () => {
    const devices = owner();
    await invited(devices);
    const shown = candidate();
    relay.pending = [shown];
    await devices.read("pair_1");
    relay.approveCandidate.mockRejectedValueOnce(
      new RelayError("invalid_state", "pairing is approved", 409)
    );
    relay.verifiedDevices.mockResolvedValueOnce([
      {
        device_id: shown.device_id,
        revoked_at: null,
        cert: { label: "Greg's iPhone", signing_pub: "sig", exchange_pub: "exch" },
      },
    ]);

    await expect(devices.approve({ pairingId: "pair_1", code: "482913" })).resolves.toEqual({
      result: "paired",
      label: "Greg's iPhone",
    });
  });

  it("expires an invitation by its own deadline without asking the relay", async () => {
    let clock = Date.now();
    const devices = owner(stored(), () => clock);
    relay.createPairingInvite.mockResolvedValueOnce({
      url: `${ORIGIN}/pair#payload`,
      payload: {},
      pairingId: "pair_1",
      expiresAt: clock + 1000,
    });
    await devices.invite();
    clock += 1000;

    await expect(devices.read("pair_1")).resolves.toEqual({ state: "expired" });
    expect(relay.pendingPairings).not.toHaveBeenCalled();
  });

  it("reconciles an approval sent before the deadline instead of declaring it expired", async () => {
    let clock = Date.now();
    const devices = owner(stored(), () => clock);
    relay.createPairingInvite.mockResolvedValueOnce({
      url: `${ORIGIN}/pair#payload`,
      payload: {},
      pairingId: "pair_1",
      expiresAt: clock + 60_000,
    });
    await devices.invite();
    const shown = candidate();
    relay.pending = [shown];
    await devices.read("pair_1");
    relay.approveCandidate.mockRejectedValueOnce(new RelayError("network_error", "network", 0));
    relay.lastFailure = { reason: "timeout", answered: true };
    await devices.approve({ pairingId: "pair_1", code: "482913" });
    clock += 60_000;
    relay.verifiedDevices.mockResolvedValueOnce([
      {
        device_id: shown.device_id,
        revoked_at: null,
        cert: { label: "Greg's iPhone", signing_pub: "sig", exchange_pub: "exch" },
      },
    ]);

    await expect(devices.read("pair_1")).resolves.toEqual({
      state: "paired",
      label: "Greg's iPhone",
    });
  });

  it("knows only invitations it made", async () => {
    await expect(owner().read("pair_other")).resolves.toEqual({ state: "unknown" });
  });

  it.each([
    ["forbidden", 403, "full"],
    ["rate_limited", 429, "busy"],
  ] as const)("reads a %s refusal of an invitation as %s", async (code, status, result) => {
    relay.createPairingInvite.mockRejectedValueOnce(new RelayError(code, code, status));

    await expect(owner().invite()).resolves.toEqual({ result });
  });

  it("lists the other unrevoked devices with what the relay observed", async () => {
    const at = "2026-10-01T10:00:00.000Z";
    const cert = (role: string, label: string) => ({ role, label });
    relay.verifiedDevices.mockResolvedValueOnce([
      {
        device_id: DEVICE,
        revoked_at: null,
        created_at: at,
        last_seen_at: at,
        push_enabled: false,
        cert: cert("owner-desktop", "Daintree"),
      },
      {
        device_id: "dev_phone_1",
        revoked_at: null,
        created_at: at,
        last_seen_at: null,
        push_enabled: true,
        cert: cert("phone", "Greg's iPhone"),
      },
      {
        device_id: "dev_phone_2",
        revoked_at: at,
        created_at: at,
        last_seen_at: at,
        push_enabled: true,
        cert: cert("phone", "Old phone"),
      },
    ]);

    await expect(owner().list()).resolves.toEqual({
      result: "listed",
      devices: [
        {
          deviceId: "dev_phone_1",
          label: "Greg's iPhone",
          role: "phone",
          pairedAt: at,
          lastSeenAt: null,
          pushEnabled: true,
        },
      ],
    });
  });

  it("is not set up when the sealed keys belong to another relay", async () => {
    const devices = owner(stored({ relayOrigin: "https://other.example.workers.dev" }));

    await expect(devices.list()).resolves.toEqual({ result: "not-set-up" });
    expect(relay.verifiedDevices).not.toHaveBeenCalled();
  });

  it("reads a relay that refuses this computer's keys as not recognised", async () => {
    relay.verifiedDevices.mockRejectedValueOnce(
      new RelayError("not_authenticated", "unknown or revoked device", 401)
    );

    await expect(owner().list()).resolves.toEqual({
      result: "refused",
      origin: ORIGIN,
      reason: "not-recognised",
    });
  });

  it("forgets every invitation when disposed", async () => {
    const devices = owner();
    await invited(devices);
    devices.dispose();

    await expect(devices.read("pair_1")).resolves.toEqual({ state: "unknown" });
  });

  it("approves only once its turn among the key rotations comes, and re-reads what it holds then", async () => {
    const devices = owner();
    await invited(devices);
    relay.pending = [candidate()];
    await devices.read("pair_1");
    relay.holdQueue = true;

    const approving = devices.approve({ pairingId: "pair_1", code: "482913" });
    await vi.waitFor(() => expect(relay.queue).toHaveLength(1));
    // Declined while the approval waited behind a rotation.
    await devices.decline("pair_1");
    releaseQueue();

    await expect(approving).resolves.toEqual({ result: "changed" });
    expect(relay.approveCandidate).not.toHaveBeenCalled();
  });

  it("runs a Host enrollment's sealing only once its turn among the key rotations comes", async () => {
    const devices = owner();
    relay.holdQueue = true;
    const sealed = vi.fn(async () => "sealed");

    const enrolling = devices.withCurrentKeys(sealed);
    await vi.waitFor(() => expect(relay.queue).toHaveLength(1));
    expect(sealed).not.toHaveBeenCalled();
    releaseQueue();

    await expect(enrolling).resolves.toBe("sealed");
    expect(sealed).toHaveBeenCalledOnce();
  });

  it("answers what stopped another owner operation's request as an observation", async () => {
    const devices = owner();
    relay.lastFailure = { reason: "timeout", answered: false };
    await expect(
      devices.withClient(async () => {
        throw new RelayError("network_error", "offline", 0);
      })
    ).resolves.toEqual({ result: "unreachable", origin: ORIGIN, reason: "timeout" });
    await expect(owner(null).withCurrentKeys(async () => "never")).resolves.toEqual({
      result: "not-set-up",
    });
  });

  it("shows a list read's revoked devices to its observer before dropping them", async () => {
    const observed: unknown[] = [];
    const devices = new OwnerDevices({
      relayOrigin: ORIGIN,
      installationId: INSTALLATION,
      deviceId: DEVICE,
      keys: { load: vi.fn(async () => stored()) },
      rotations,
      onListed: (rows) => {
        observed.push(...rows.map((row) => row.device_id));
      },
    });
    relay.verifiedDevices.mockResolvedValueOnce([
      {
        device_id: "dev_host_live",
        revoked_at: null,
        created_at: "2026-11-01T00:00:00.000Z",
        last_seen_at: null,
        push_enabled: false,
        cert: { label: "studio", role: "desktop-host" },
      },
      {
        device_id: "dev_host_gone",
        revoked_at: "2026-11-02T00:00:00.000Z",
        created_at: "2026-11-01T00:00:00.000Z",
        last_seen_at: null,
        push_enabled: false,
        cert: { label: "lab", role: "desktop-host" },
      },
    ]);

    const listed = await devices.list();
    expect(observed).toEqual(["dev_host_live", "dev_host_gone"]);
    expect(listed).toMatchObject({ result: "listed", devices: [{ deviceId: "dev_host_live" }] });
  });

  it("expires an approval whose invitation lapsed while it waited its turn", async () => {
    let clock = Date.now();
    const devices = owner(stored(), () => clock);
    await invited(devices);
    relay.pending = [candidate()];
    await devices.read("pair_1");
    relay.holdQueue = true;

    const approving = devices.approve({ pairingId: "pair_1", code: "482913" });
    await vi.waitFor(() => expect(relay.queue).toHaveLength(1));
    clock += 300_000;
    releaseQueue();

    await expect(approving).resolves.toEqual({ result: "expired" });
    expect(relay.approveCandidate).not.toHaveBeenCalled();
  });

  it("revokes a device and reports the epoch the relay now holds", async () => {
    relay.rotate.mockResolvedValueOnce({ outcome: "done", epoch: 4, revoked: "dev_phone_1" });

    await expect(owner().revoke("dev_phone_1")).resolves.toEqual({
      result: "revoked",
      keyEpoch: 4,
    });
    expect(relay.rotate).toHaveBeenCalledWith(expect.anything(), "dev_phone_1");
  });

  it("never revokes this computer", async () => {
    await expect(owner().revoke(DEVICE)).resolves.toEqual({ result: "not-found" });
    expect(relay.rotate).not.toHaveBeenCalled();
  });

  it("rotates without naming a device", async () => {
    relay.rotate.mockResolvedValueOnce({ outcome: "done", epoch: 2, revoked: null });

    await expect(owner().rotate()).resolves.toEqual({ result: "rotated", keyEpoch: 2 });
    expect(relay.rotate).toHaveBeenCalledWith(expect.anything(), null);
  });

  it("says when the relay's answer was lost, naming the relay, and when the key wasn't saved", async () => {
    relay.rotate.mockResolvedValueOnce({
      outcome: "unconfirmed",
      error: new RelayError("network_error", "socket hang up", 0),
    });
    await expect(owner().revoke("dev_phone_1")).resolves.toEqual({
      result: "unconfirmed",
      origin: ORIGIN,
    });

    relay.rotate.mockResolvedValueOnce({ outcome: "unsaved", error: new Error("disk full") });
    await expect(owner().rotate()).resolves.toEqual({
      result: "unsaved",
      reason: "The key file couldn't be written",
    });
  });

  it("reads refusals that changed nothing as such", async () => {
    relay.rotate
      .mockResolvedValueOnce({ outcome: "not-found" })
      .mockResolvedValueOnce({ outcome: "unverified" })
      .mockResolvedValueOnce({ outcome: "conflict" })
      .mockResolvedValueOnce({ outcome: "superseded" });

    await expect(owner().revoke("dev_phone_1")).resolves.toEqual({ result: "not-found" });
    await expect(owner().rotate()).resolves.toEqual({ result: "unverified" });
    await expect(owner().rotate()).resolves.toEqual({ result: "conflict" });
    await expect(owner().rotate()).resolves.toEqual({ result: "conflict" });
  });

  it("reads an unreachable relay during a rotation as an observation", async () => {
    relay.lastFailure = { reason: "timeout", answered: false };
    relay.rotate.mockRejectedValueOnce(new RelayError("network_error", "timed out", 0));

    await expect(owner().rotate()).resolves.toEqual({
      result: "unreachable",
      origin: ORIGIN,
      reason: "timeout",
    });
  });
});
