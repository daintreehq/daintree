// Keeps one repeated console line from filling the breadcrumb ring: a renderer
// polling six dead terminal ids every 5s once left 147 of 250 breadcrumbs as
// the same expected "not found", pushing the lead-up to a crash out (#13542).

export interface LimitableBreadcrumb {
  category?: string;
  level?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export const REPEAT_WINDOW_MS = 60_000;
export const REPEATS_PER_WINDOW = 3;
const MAX_SIGNATURES = 200;

// Ids, timestamps and durations that change between otherwise identical lines.
// Plain short numbers stay: they are usually error codes, and those tell
// causes apart.
const VOLATILE_TOKEN = new RegExp(
  [
    String.raw`\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?`,
    String.raw`\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`,
    String.raw`\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b`,
    String.raw`\b\d+(?:\.\d+)?(?:ms|s)\b`,
    String.raw`\b\d{5,}\b`,
  ].join("|"),
  "gi"
);

export function breadcrumbSignature(breadcrumb: LimitableBreadcrumb): string {
  const message = (breadcrumb.message ?? "").replace(VOLATILE_TOKEN, "<id>");
  return `${breadcrumb.category ?? ""}|${breadcrumb.level ?? ""}|${message}`;
}

interface SignatureWindow {
  start: number;
  admitted: number;
  suppressed: number;
}

export class BreadcrumbRepeatLimiter {
  private windows = new Map<string, SignatureWindow>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Returns the breadcrumb to keep, or null to drop it. */
  filter<T extends LimitableBreadcrumb>(breadcrumb: T): T | null {
    if (breadcrumb.category !== "console") return breadcrumb;
    const signature = breadcrumbSignature(breadcrumb);
    const now = this.now();
    let window = this.windows.get(signature);
    if (window && now - window.start >= REPEAT_WINDOW_MS) {
      const suppressed = window.suppressed;
      window = { start: now, admitted: 1, suppressed: 0 };
      this.track(signature, window);
      if (suppressed === 0) return breadcrumb;
      return { ...breadcrumb, data: { ...breadcrumb.data, suppressedRepeats: suppressed } };
    }
    if (!window) {
      this.track(signature, { start: now, admitted: 1, suppressed: 0 });
      return breadcrumb;
    }
    if (window.admitted < REPEATS_PER_WINDOW) {
      window.admitted++;
      return breadcrumb;
    }
    window.suppressed++;
    return null;
  }

  clear(): void {
    this.windows.clear();
  }

  private track(signature: string, window: SignatureWindow): void {
    this.windows.delete(signature);
    this.windows.set(signature, window);
    if (this.windows.size <= MAX_SIGNATURES) return;
    const now = this.now();
    for (const [key, value] of this.windows) {
      if (now - value.start >= REPEAT_WINDOW_MS) this.windows.delete(key);
    }
    while (this.windows.size > MAX_SIGNATURES) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}
