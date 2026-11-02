import {
  generateDeviceKeys,
  issueDeviceCert,
  randomBytes,
  serializeDeviceKeys,
} from "@daintreehq/decisions-crypto";
import { bytesToBase64Url, type DeviceCert } from "@daintreehq/decisions-protocol";
import {
  importIdentity,
  type Identity,
  type RelayClient,
  type StoredIdentity,
} from "@daintreehq/decisions-client";

export const RELAY_ORIGIN = "https://decisions.example.workers.dev";

interface FakeDevice {
  device_id: string;
  role: string;
  label: string;
  cert: DeviceCert;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  push_enabled: boolean;
}

/**
 * A real owner identity, made with the library's own crypto, and a relay
 * that only keeps its device list: enough for the library's `enrollHost` to
 * check, sign, seal and register for real.
 */
export async function makeOwner(options: { installationId?: string; deviceId?: string } = {}) {
  const installationId = options.installationId ?? "inst_owner_0123456789";
  const deviceId = options.deviceId ?? "dev_owner_desktop_01";
  const keys = await generateDeviceKeys(true);
  const stored: StoredIdentity = {
    v: 1,
    config: { relayOrigin: RELAY_ORIGIN, installationId, deviceId, label: "Owner's Mac" },
    keys: await serializeDeviceKeys(keys),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(randomBytes(32)) }],
    currentEpoch: 1,
  };
  const identity: Identity = await importIdentity(stored);
  const ownerCert = await issueDeviceCert({
    issuerDeviceId: deviceId,
    issuerSigningKey: identity.keys.signing.privateKey,
    installationId,
    deviceId,
    role: "owner-desktop",
    label: "Owner's Mac",
    signingPub: identity.signingPub,
    exchangePub: identity.exchangePub,
  });
  const devices: FakeDevice[] = [
    {
      device_id: deviceId,
      role: "owner-desktop",
      label: "Owner's Mac",
      cert: ownerCert,
      created_at: new Date().toISOString(),
      last_seen_at: null,
      revoked_at: null,
      push_enabled: false,
    },
  ];
  const registered: Array<{ cert: DeviceCert; grant: unknown }> = [];
  const relay = {
    identity,
    devices: async () => ({ key_epoch: 1, owner_device_id: deviceId, devices }),
    enrollHost: async (cert: DeviceCert, grant: unknown) => {
      registered.push({ cert, grant });
      devices.push({
        device_id: cert.device_id,
        role: cert.role,
        label: cert.label,
        cert,
        created_at: new Date().toISOString(),
        last_seen_at: null,
        revoked_at: null,
        push_enabled: false,
      });
      return {};
    },
  };
  return {
    installationId,
    deviceId,
    stored,
    identity,
    devices,
    registered,
    client: relay as unknown as RelayClient,
    revoke(id: string) {
      const device = devices.find((entry) => entry.device_id === id);
      if (device) device.revoked_at = new Date().toISOString();
    },
  };
}

/** An in-memory stand-in for a machine's sealed key store, with a keychain that can be taken away. */
export function memoryKeys(initial: StoredIdentity | null = null) {
  let value: StoredIdentity | null = initial ? structuredClone(initial) : null;
  const state = {
    keychain: { kind: "keychain" } as
      | { kind: "keychain" }
      | { kind: "weak" | "locked" | "unavailable" | "timeout"; reason: string },
    saves: 0,
    opened: 0,
    closed: 0,
  };
  return {
    state,
    current: () => value,
    open: () => {
      state.opened += 1;
      return {
        load: async () => (value ? structuredClone(value) : null),
        save: async (identity: StoredIdentity) => {
          state.saves += 1;
          value = structuredClone(identity);
        },
        check: async () => state.keychain,
        close: async () => {
          state.closed += 1;
        },
      };
    },
  };
}
