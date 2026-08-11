const BASE_BAN_MS = 1_000;
const MAX_BAN_MS = 5 * 60_000;
const VIOLATION_MEMORY_MS = 10 * 60_000;

interface AbuseRecord {
  violations: number;
  lastViolationAt: number;
  bannedUntil: number;
}

export class RemoteAbuseGuard {
  private readonly records = new Map<string, AbuseRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  isBanned(deviceId: string, sourceAddress: string): boolean {
    const record = this.records.get(this.key(deviceId, sourceAddress));
    if (!record) return false;
    if (this.now() - record.lastViolationAt >= VIOLATION_MEMORY_MS) {
      this.records.delete(this.key(deviceId, sourceAddress));
      return false;
    }
    return this.now() < record.bannedUntil;
  }

  recordViolation(deviceId: string, sourceAddress: string): number {
    const key = this.key(deviceId, sourceAddress);
    const previous = this.records.get(key);
    const violations =
      previous && this.now() - previous.lastViolationAt < VIOLATION_MEMORY_MS
        ? previous.violations + 1
        : 1;
    const banMs = Math.min(BASE_BAN_MS * 2 ** (violations - 1), MAX_BAN_MS);
    this.records.set(key, {
      violations,
      lastViolationAt: this.now(),
      bannedUntil: this.now() + banMs,
    });
    return banMs;
  }

  clear(): void {
    this.records.clear();
  }

  private key(deviceId: string, sourceAddress: string): string {
    return `${deviceId}\0${sourceAddress}`;
  }
}
