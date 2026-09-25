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
  instanceKey?: string;
}

/** Split a registry key into the identity fields a log line carries. */
export function pluginFileLogIdentity(registryId: string): PluginFileLogIdentity {
  const parsed = parseProjectPluginInstanceKey(registryId);
  if (!parsed) return { pluginId: registryId };
  return { pluginId: parsed.manifestId, projectId: parsed.projectId, instanceKey: registryId };
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
  const scrubbed = scrubSecrets(typeof text === "string" ? text : String(text));
  const codepoints = Array.from(scrubbed);
  if (codepoints.length <= maxChars) return scrubbed;
  return `${codepoints.slice(0, maxChars - 1).join("")}…`;
}

export type PluginFileLogBudget = Record<PluginFileLogCategory, number>;

export interface PluginFileLogLimiterOptions {
  windowMs: number;
  perPlugin: PluginFileLogBudget;
  global: PluginFileLogBudget;
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

interface PluginWindow extends WindowCounts {
  suppressed: PluginFileLogSuppressed;
}

export const DEFAULT_PLUGIN_FILE_LOG_LIMITS: PluginFileLogLimiterOptions = {
  windowMs: 10_000,
  perPlugin: { error: 5, warn: 10, lifecycle: 20 },
  global: { error: 20, warn: 40, lifecycle: 100 },
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
  private readonly globalWindow: WindowCounts;

  constructor(options: PluginFileLogLimiterOptions = DEFAULT_PLUGIN_FILE_LOG_LIMITS) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.globalWindow = { start: this.now(), used: emptyCounts() };
  }

  admit(pluginId: string, category: PluginFileLogCategory): PluginFileLogAdmission {
    const now = this.now();
    const { windowMs, perPlugin, global } = this.options;

    if (now - this.globalWindow.start >= windowMs) {
      this.globalWindow.start = now;
      this.globalWindow.used = emptyCounts();
    }

    let window = this.windows.get(pluginId);
    let suppressedInPreviousWindow: PluginFileLogSuppressed | undefined;
    if (!window) {
      window = { start: now, used: emptyCounts(), suppressed: {} };
      this.windows.set(pluginId, window);
    } else if (now - window.start >= windowMs) {
      if (hasSuppressed(window.suppressed)) suppressedInPreviousWindow = window.suppressed;
      window.start = now;
      window.used = emptyCounts();
      window.suppressed = {};
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

  /** Forget a plugin, returning whatever it had dropped in its open window. */
  drain(pluginId: string): PluginFileLogSuppressed | undefined {
    const window = this.windows.get(pluginId);
    this.windows.delete(pluginId);
    return window && hasSuppressed(window.suppressed) ? window.suppressed : undefined;
  }
}
