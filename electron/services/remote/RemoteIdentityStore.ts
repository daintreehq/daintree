import { eq } from "drizzle-orm";
import type { RemoteCapability, RemotePairedDevice } from "../../../shared/types/remote/index.js";
import {
  RemoteCapabilitiesSchema,
  RemotePairedDeviceSchema,
} from "../../../shared/types/remote/index.js";
import type { AppDb } from "../persistence/db.js";
import {
  remoteDevices,
  remoteHostIdentities,
  remoteTlsIdentities,
  type RemoteDeviceRow,
  type RemoteHostIdentityRow,
} from "../persistence/schema.js";

export const REMOTE_IDENTITY_SCHEMA_VERSION = 1;

export interface StoredRemoteHostIdentity {
  schemaVersion: number;
  hostId: string;
  publicKey: string;
  fingerprint: string;
  encryptedPrivateKey: string;
  createdAt: number;
}

export interface StoredRemoteTlsIdentity {
  schemaVersion: number;
  hostId: string;
  certificate: string;
  certificateFingerprint: string;
  encryptedPrivateKey: string;
  createdAt: number;
}

export interface RemoteIdentityStore {
  getHostIdentity(): StoredRemoteHostIdentity | null;
  saveHostIdentity(identity: StoredRemoteHostIdentity): void;
  getTlsIdentity(hostId: string): StoredRemoteTlsIdentity | null;
  saveTlsIdentity(identity: StoredRemoteTlsIdentity): void;
  getDevice(deviceId: string): RemotePairedDevice | null;
  listDevices(): RemotePairedDevice[];
  saveDevice(device: RemotePairedDevice): void;
}

function hostFromRow(row: RemoteHostIdentityRow): StoredRemoteHostIdentity {
  return {
    schemaVersion: row.schemaVersion,
    hostId: row.hostId,
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    encryptedPrivateKey: row.encryptedPrivateKey,
    createdAt: row.createdAt,
  };
}

function parseCapabilities(value: string): RemoteCapability[] {
  return RemoteCapabilitiesSchema.parse(JSON.parse(value));
}

function deviceFromRow(row: RemoteDeviceRow): RemotePairedDevice {
  if (row.schemaVersion !== REMOTE_IDENTITY_SCHEMA_VERSION) {
    throw new Error(`Unsupported remote device schema version ${row.schemaVersion}`);
  }
  const { schemaVersion: _schemaVersion, capabilities, ...device } = row;
  return RemotePairedDeviceSchema.parse({
    ...device,
    capabilities: parseCapabilities(capabilities),
  });
}

export class SqliteRemoteIdentityStore implements RemoteIdentityStore {
  constructor(private readonly db: AppDb) {}

  getHostIdentity(): StoredRemoteHostIdentity | null {
    const row = this.db.select().from(remoteHostIdentities).limit(1).get();
    return row ? hostFromRow(row) : null;
  }

  saveHostIdentity(identity: StoredRemoteHostIdentity): void {
    this.db
      .insert(remoteHostIdentities)
      .values({ id: "primary", ...identity })
      .onConflictDoUpdate({
        target: remoteHostIdentities.id,
        set: identity,
      })
      .run();
  }

  getTlsIdentity(hostId: string): StoredRemoteTlsIdentity | null {
    return (
      this.db
        .select()
        .from(remoteTlsIdentities)
        .where(eq(remoteTlsIdentities.hostId, hostId))
        .get() ?? null
    );
  }

  saveTlsIdentity(identity: StoredRemoteTlsIdentity): void {
    this.db
      .insert(remoteTlsIdentities)
      .values(identity)
      .onConflictDoUpdate({ target: remoteTlsIdentities.hostId, set: identity })
      .run();
  }

  getDevice(deviceId: string): RemotePairedDevice | null {
    const row = this.db.select().from(remoteDevices).where(eq(remoteDevices.id, deviceId)).get();
    if (!row) return null;
    return deviceFromRow(row);
  }

  listDevices(): RemotePairedDevice[] {
    return this.db.select().from(remoteDevices).all().map(deviceFromRow);
  }

  saveDevice(device: RemotePairedDevice): void {
    const row = {
      ...device,
      schemaVersion: REMOTE_IDENTITY_SCHEMA_VERSION,
      capabilities: JSON.stringify(device.capabilities),
    };
    this.db
      .insert(remoteDevices)
      .values(row)
      .onConflictDoUpdate({ target: remoteDevices.id, set: row })
      .run();
  }
}
