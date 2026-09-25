import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";
import { parseProjectPluginInstanceKey } from "../../../shared/types/plugin.js";

/**
 * Durable-log plumbing for plugin diagnostics (#12804). What a plugin reports
 * through `host.logger`, and what the host observes about its lifecycle, has to
 * reach `daintree.log` so a diagnostics bundle can tell "never activated" from
 * "worker failed" from "plugin reported an error" — but the text is
 * plugin-controlled, so every line is bounded in size here and in rate by
 * {@link PluginFileLogLimiter}.
 */

/**
 * Per-field cap for plugin-authored text in a file-log context. Sits under the
 * shared logger's own 2000-unit string clamp so a line is cut here, codepoint
 * safe, rather than bisected there.
 */
export const PLUGIN_FILE_LOG_TEXT_MAX_CHARS = 1000;

export type PluginFileLogCategory = "error" | "warn" | "lifecycle";

export interface PluginFileLogIdentity {
  /** The manifest id — what the plugin's author and the user know it as. */
  pluginId: string;
  projectId?: string;
  /**
   * The registry key. Not named `instanceKey`: the logger redacts any context
   * key containing "key", which would blank it in the file.
   */
  instanceId?: string;
}

/** Split a registry key into the identity fields a log line carries. */
export function pluginFileLogIdentity(registryId: string): PluginFileLogIdentity {
  const parsed = parseProjectPluginInstanceKey(registryId);
  if (!parsed) return { pluginId: registryId };
  return { pluginId: parsed.manifestId, projectId: parsed.projectId, instanceId: registryId };
}

/**
 * Scrub, then cap by codepoint. Scrubbing first means a secret straddling the
 * cut is fully redacted rather than truncated into a fragment the scrubber can
 * no longer recognise.
 */
export function boundPluginFileLogText(
  text: unknown,
  maxChars: number = PLUGIN_FILE_LOG_TEXT_MAX_CHARS
): string {
  const scrubbed = scrubSecrets(typeof text === "string" ? text : toPrintable(text));
  const codepoints = Array.from(scrubbed);
  if (codepoints.length <= maxChars) return scrubbed;
  return `${codepoints.slice(0, maxChars - 1).join("")}…`;
}

function toPrintable(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
}

export type PluginFileLogBudget = Record<PluginFileLogCategory, number>;

export interface PluginFileLogLimiterOptions {
  windowMs: number;
  perPlugin: PluginFileLogBudget;
  global: PluginFileLogBudget;
  /** Suppression summaries across all plugins per window. */
  globalSummaries: number;
  now?: () => number;
}

export type PluginFileLogSuppressed = Partial<Record<PluginFileLogCategory, number>>;

export interface PluginFileLogAdmission {
  admitted: boolean;
  /**
   * Set when this call closed out a window in which the plugin had lines
   * dropped. The caller writes one summary line so the gap is visible.
   */
  suppressedInPreviousWindow?: PluginFileLogSuppressed;
}

interface WindowCounts {
  start: number;
  used: Record<PluginFileLogCategory, number>;
}

interface GlobalWindow extends WindowCounts {
  summaries: number;
}

interface PluginWindow extends WindowCounts {
  suppressed: PluginFileLogSuppressed;
}

export const DEFAULT_PLUGIN_FILE_LOG_LIMITS: PluginFileLogLimiterOptions = {
  windowMs: 10_000,
  perPlugin: { error: 5, warn: 10, lifecycle: 20 },
  global: { error: 20, warn: 40, lifecycle: 100 },
  globalSummaries: 10,
};

function emptyCounts(): Record<PluginFileLogCategory, number> {
  return { error: 0, warn: 0, lifecycle: 0 };
}

function hasSuppressed(suppressed: PluginFileLogSuppressed): boolean {
  return Object.values(suppressed).some((n) => (n ?? 0) > 0);
}

/**
 * Fixed-window admission, per plugin and across all plugins, with a separate
 * budget per category so a plugin's warning chatter can never spend the
 * allowance its errors or its lifecycle evidence need. Dropped lines are
 * counted, never stored. No timers: a window's summary surfaces on the
 * plugin's next line, or through {@link drain} when it unloads.
 */
export class PluginFileLogLimiter {
  private readonly options: PluginFileLogLimiterOptions;
  private readonly now: () => number;
  private readonly windows = new Map<string, PluginWindow>();
  private readonly globalWindow: GlobalWindow;

  constructor(options: PluginFileLogLimiterOptions = DEFAULT_PLUGIN_FILE_LOG_LIMITS) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.globalWindow = { start: this.now(), used: emptyCounts(), summaries: 0 };
  }

  admit(pluginId: string, category: PluginFileLogCategory): PluginFileLogAdmission {
    const now = this.now();
    const { perPlugin, global } = this.options;
    this.rollGlobalWindow(now);

    let window = this.windows.get(pluginId);
    let suppressedInPreviousWindow: PluginFileLogSuppressed | undefined;
    if (!window) {
      window = { start: now, used: emptyCounts(), suppressed: {} };
      this.windows.set(pluginId, window);
    } else if (this.expired(window.start, now)) {
      let carried: PluginFileLogSuppressed = {};
      if (hasSuppressed(window.suppressed)) {
        // Summaries are rate-bound too: with many noisy plugins rolling over at
        // once, the ones past the global allowance carry their counts into the
        // next window rather than each writing a line now.
        if (this.takeSummary()) suppressedInPreviousWindow = window.suppressed;
        else carried = window.suppressed;
      }
      window.start = now;
      window.used = emptyCounts();
      window.suppressed = carried;
    }

    // Both limits are checked before either is spent, so a line the global cap
    // refuses does not also eat the plugin's own allowance.
    const admitted =
      window.used[category] < perPlugin[category] &&
      this.globalWindow.used[category] < global[category];
    if (admitted) {
      window.used[category] += 1;
      this.globalWindow.used[category] += 1;
    } else {
      window.suppressed[category] = (window.suppressed[category] ?? 0) + 1;
    }

    return suppressedInPreviousWindow ? { admitted, suppressedInPreviousWindow } : { admitted };
  }

  /**
   * Forget a plugin, returning whatever it had dropped in its open window — or
   * nothing, when the global summary allowance for this window is spent.
   */
  drain(pluginId: string): PluginFileLogSuppressed | undefined {
    const window = this.windows.get(pluginId);
    this.windows.delete(pluginId);
    if (!window || !hasSuppressed(window.suppressed)) return undefined;
    this.rollGlobalWindow(this.now());
    return this.takeSummary() ? window.suppressed : undefined;
  }

  private rollGlobalWindow(now: number): void {
    if (!this.expired(this.globalWindow.start, now)) return;
    this.globalWindow.start = now;
    this.globalWindow.used = emptyCounts();
    this.globalWindow.summaries = 0;
  }

  private takeSummary(): boolean {
    if (this.globalWindow.summaries >= this.options.globalSummaries) return false;
    this.globalWindow.summaries += 1;
    return true;
  }

  /** A clock that stepped backwards also ends the window, so it cannot stall. */
  private expired(start: number, now: number): boolean {
    return now < start || now - start >= this.options.windowMs;
  }
}
