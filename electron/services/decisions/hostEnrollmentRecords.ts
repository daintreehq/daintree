import type { DaintreeLocalStore } from "./daintreeLocalStore.js";

/** Where the owner keeps what it knows of its Hosts, beside the relay binding. */
export const HOST_RECORDS_META_KEY = "daintree:enrolled-hosts";

/** What the owner knows of one Host, by the id its host list gives it. */
export interface HostRecord {
  /** The device the Host last held as this owner's, once it accepted an enrollment; null before. */
  deviceId: string | null;
  enrolledAt: number | null;
  /**
   * When that device was seen revoked (epoch ms). While set, the Host is never
   * enrolled automatically; only Enroll clears it, once it succeeds.
   */
  revokedAt: number | null;
}

interface RecordsFile {
  v: 1;
  /** The installation the records belong to; another relay's are none of this one's. */
  installationId: string;
  hosts: Record<string, HostRecord>;
}

type MetaStore = Pick<DaintreeLocalStore, "getMeta" | "setMeta">;

function epochMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function recordOf(value: unknown): HostRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  return {
    deviceId: typeof raw.deviceId === "string" && raw.deviceId !== "" ? raw.deviceId : null,
    enrolledAt: epochMs(raw.enrolledAt),
    revokedAt: epochMs(raw.revokedAt),
  };
}

/**
 * The owner's record of its enrolled and revoked Hosts (#16021), one entry
 * per Host in the app database's Decisions meta table, so deleting local data
 * deletes it with everything else. Records of another installation read as
 * none and are replaced by the first write. Writes run one at a time, each
 * reading what the last left.
 */
export class HostRecords {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: MetaStore,
    private readonly installationId: string
  ) {}

  /** Every Host's record. Rejects when the store can't be read. */
  read(): Promise<Map<string, HostRecord>> {
    return this.enqueue(() => this.load());
  }

  async get(hostId: string): Promise<HostRecord | null> {
    return (await this.read()).get(hostId) ?? null;
  }

  /** The Host now holds `deviceId` as this owner's, active: any revocation is behind it. */
  markEnrolled(hostId: string, deviceId: string, now: number): Promise<HostRecord> {
    return this.update(hostId, (current) => ({
      deviceId,
      enrolledAt: current?.deviceId === deviceId ? (current.enrolledAt ?? now) : now,
      revokedAt: null,
    }));
  }

  /** The Host's device was seen revoked. The first sighting's time stands. */
  markRevoked(hostId: string, deviceId: string | null, now: number): Promise<HostRecord> {
    return this.update(hostId, (current) => ({
      deviceId: deviceId ?? current?.deviceId ?? null,
      enrolledAt: current?.enrolledAt ?? null,
      revokedAt: current?.revokedAt ?? now,
    }));
  }

  private update(
    hostId: string,
    next: (current: HostRecord | null) => HostRecord
  ): Promise<HostRecord> {
    return this.enqueue(async () => {
      const hosts = await this.load();
      const record = next(hosts.get(hostId) ?? null);
      hosts.set(hostId, record);
      const file: RecordsFile = {
        v: 1,
        installationId: this.installationId,
        hosts: Object.fromEntries(hosts),
      };
      await this.store.setMeta(HOST_RECORDS_META_KEY, JSON.stringify(file));
      return record;
    });
  }

  private async load(): Promise<Map<string, HostRecord>> {
    const text = await this.store.getMeta(HOST_RECORDS_META_KEY);
    const hosts = new Map<string, HostRecord>();
    if (text === null) return hosts;
    let file: unknown;
    try {
      file = JSON.parse(text);
    } catch {
      // Written only here, whole; a damaged one is read as none, and a Host
      // whose identity was revoked still says so on its next connection.
      console.warn("[Decisions] The enrolled-Hosts record was damaged, so it was read as empty");
      return hosts;
    }
    const parsed = file as Partial<RecordsFile> | null;
    if (
      parsed?.v !== 1 ||
      parsed.installationId !== this.installationId ||
      typeof parsed.hosts !== "object" ||
      parsed.hosts === null
    ) {
      return hosts;
    }
    for (const [hostId, value] of Object.entries(parsed.hosts)) {
      const record = recordOf(value);
      if (record) hosts.set(hostId, record);
    }
    return hosts;
  }

  private enqueue<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step);
    this.queue = run.catch(() => {});
    return run;
  }
}
