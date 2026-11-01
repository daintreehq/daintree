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

function owner(identity: StoredIdentity | null = stored(), now = () => Date.now()) {
  return new OwnerDevices({
    relayOrigin: ORIGIN,
    installationId: INSTALLATION,
    deviceId: DEVICE,
    keys: { load: vi.fn(async () => identity) },
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
});
