import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { AgentPreset } from "../../shared/config/agentRegistry.js";
import { setAgentPresets } from "../../shared/config/agentRegistry.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface CcrModelEntry {
  id?: string;
  name?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  [key: string]: unknown;
}

interface CcrConfig {
  models?: CcrModelEntry[];
  [key: string]: unknown;
}

// E2E isolation: the main process path defaults to `~/.claude-code-router/config.json`,
// but tests running in parallel need to point each instance at its own config file so
// they don't clobber each other's state. DAINTREE_CCR_CONFIG_PATH overrides the default.
const CCR_CONFIG_PATH =
  process.env.DAINTREE_CCR_CONFIG_PATH ?? join(homedir(), ".claude-code-router", "config.json");

function presetsChanged(prev: AgentPreset[] | null, next: AgentPreset[]): boolean {
  if (!prev) return next.length > 0;
  if (prev.length !== next.length) return true;
  // Deep compare: id/name/env/args/color/description. Environment and routing
  // fields (ANTHROPIC_MODEL, ANTHROPIC_BASE_URL, API keys) are encoded in each
  // preset's env map — if those change in ~/.claude-code-router/config.json we
  // must rebroadcast so the renderer doesn't keep launching with stale baseUrl.
  // JSON.stringify is sufficient for the small preset count and sidesteps the
  // field-by-field drift risk.
  try {
    return JSON.stringify(prev) !== JSON.stringify(next);
  } catch {
    // Circular structures shouldn't occur in AgentPreset but be defensive.
    return true;
  }
}

export class CcrConfigService {
  private static instance: CcrConfigService | null = null;
  private cachedPresets: AgentPreset[] | null = null;
  private pendingBroadcast = true;
  private watchAbortController: AbortController | null = null;
  private pollPromise: Promise<void> | null = null;

  static getInstance(): CcrConfigService {
    if (!CcrConfigService.instance) {
      CcrConfigService.instance = new CcrConfigService();
    }
    return CcrConfigService.instance;
  }

  async loadAndApply(): Promise<AgentPreset[]> {
    const presets = await this.discoverPresets();
    const changed = presetsChanged(this.cachedPresets, presets);
    setAgentPresets("claude", presets);
    this.cachedPresets = presets;
    if (changed || this.pendingBroadcast) {
      this.pendingBroadcast = false;
      try {
        broadcastToRenderer(CHANNELS.AGENT_PRESETS_UPDATED, {
          agentId: "claude",
          presets,
        });
      } catch {
        // Broadcast may fail during shutdown or before windows are ready
      }
    }
    return presets;
  }

  async discoverPresets(): Promise<AgentPreset[]> {
    let raw: string;
    try {
      raw = await readFile(CCR_CONFIG_PATH, "utf-8");
    } catch (err) {
      // ENOENT is expected when CCR isn't installed; stay silent.
      // Anything else (EACCES, EPERM, EISDIR, …) is a diagnostic the user can act on.
      const code =
        err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
      if (code !== "ENOENT") {
        console.warn(`[CcrConfigService] Failed to read config at ${CCR_CONFIG_PATH}:`, err);
      }
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // JSON.parse SyntaxError messages typically carry positional info only.
      // V8 can include a short token near the error site, but for the realistic
      // CCR shape (object with quoted values) the message is positional. Never
      // log `raw` — it may contain inline API keys from a malformed user config.
      console.warn(`[CcrConfigService] Failed to parse config at ${CCR_CONFIG_PATH}:`, err);
      return [];
    }

    // JSON.parse("null") / "true" / "[]" / '"x"' all succeed but aren't a config object.
    // Guard before reading `.models` so a malformed top-level value doesn't throw a
    // TypeError that escapes to callers as a misleading runtime error.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[CcrConfigService] Config at ${CCR_CONFIG_PATH} is not an object — ignoring`);
      return [];
    }

    const config = parsed as CcrConfig;
    if (!Array.isArray(config.models) || config.models.length === 0) {
      return [];
    }

    return config.models
      .filter(
        (entry): entry is CcrModelEntry =>
          entry != null &&
          typeof entry === "object" &&
          ((typeof entry.id === "string" && entry.id.length > 0) ||
            (typeof entry.model === "string" && entry.model.length > 0))
      )
      .map((entry) => this.entryToPreset(entry));
  }

  getPresets(): AgentPreset[] {
    return this.cachedPresets ?? [];
  }

  startWatching(): void {
    if (this.watchAbortController) return;

    this.watchAbortController = new AbortController();
    const { signal } = this.watchAbortController;

    const poll = async () => {
      while (!signal.aborted) {
        try {
          // Abortable sleep — stopWatching() triggers this to reject immediately
          // instead of blocking teardown up to 30s on the next iteration.
          await abortableSleep(30_000, signal);
        } catch {
          break;
        }
        if (signal.aborted) break;
        try {
          await this.loadAndApply();
        } catch (err) {
          // A transient failure must not kill the poll loop silently.
          console.warn("[CcrConfigService] poll iteration failed:", err);
        }
      }
    };

    this.pollPromise = poll().catch(() => {});
  }

  async stopWatching(): Promise<void> {
    // Capture locals before nulling so a racing startWatching() can install a fresh
    // loop without having its fields clobbered by this teardown.
    const controller = this.watchAbortController;
    const promise = this.pollPromise;
    this.watchAbortController = null;
    this.pollPromise = null;
    controller?.abort();
    await promise;
  }

  private entryToPreset(entry: CcrModelEntry): AgentPreset {
    // `??` only falls through on null/undefined, so an entry with `id: ""` or
    // `id: {}` would otherwise leak into preset IDs as `ccr-` or `ccr-[object Object]`.
    // Coerce non-string / empty-string fields to undefined first.
    const safeId = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined;
    const safeModel =
      typeof entry.model === "string" && entry.model.length > 0 ? entry.model : undefined;
    const safeName =
      typeof entry.name === "string" && entry.name.length > 0 ? entry.name : undefined;
    const safeBaseUrl =
      typeof entry.baseUrl === "string" && entry.baseUrl.length > 0 ? entry.baseUrl : undefined;
    const safeApiKeyEnv =
      typeof entry.apiKeyEnv === "string" && entry.apiKeyEnv.length > 0
        ? entry.apiKeyEnv
        : undefined;

    const id = safeId ?? safeModel ?? "unknown";
    const name = safeName ?? safeModel ?? id;
    const env: Record<string, string> = {};

    if (safeModel) {
      env.ANTHROPIC_MODEL = safeModel;
    }
    if (safeBaseUrl) {
      env.ANTHROPIC_BASE_URL = safeBaseUrl;
    }
    if (safeApiKeyEnv) {
      env.ANTHROPIC_API_KEY = `\${${safeApiKeyEnv}}`;
    }

    return {
      id: `ccr-${id}`,
      name: `CCR: ${name}`,
      description: `Routed via Claude Code Router (${id})`,
      env: Object.keys(env).length > 0 ? env : undefined,
    };
  }
}
