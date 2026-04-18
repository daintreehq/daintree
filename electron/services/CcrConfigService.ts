import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { AgentFlavor } from "../../shared/config/agentRegistry.js";
import { setAgentFlavors } from "../../shared/config/agentRegistry.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";

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

const CCR_CONFIG_PATH = join(homedir(), ".claude-code-router", "config.json");

function flavorsChanged(prev: AgentFlavor[] | null, next: AgentFlavor[]): boolean {
  if (!prev) return next.length > 0;
  if (prev.length !== next.length) return true;
  // Deep compare: id/name/env/args/color/description. Environment and routing
  // fields (ANTHROPIC_MODEL, ANTHROPIC_BASE_URL, API keys) are encoded in each
  // flavor's env map — if those change in ~/.claude-code-router/config.json we
  // must rebroadcast so the renderer doesn't keep launching with stale baseUrl.
  // JSON.stringify is sufficient for the small flavor count and sidesteps the
  // field-by-field drift risk.
  try {
    return JSON.stringify(prev) !== JSON.stringify(next);
  } catch {
    // Circular structures shouldn't occur in AgentFlavor but be defensive.
    return true;
  }
}

export class CcrConfigService {
  private static instance: CcrConfigService | null = null;
  private cachedFlavors: AgentFlavor[] | null = null;
  private pendingBroadcast = true;
  private watchAbortController: AbortController | null = null;

  static getInstance(): CcrConfigService {
    if (!CcrConfigService.instance) {
      CcrConfigService.instance = new CcrConfigService();
    }
    return CcrConfigService.instance;
  }

  async loadAndApply(): Promise<AgentFlavor[]> {
    const flavors = await this.discoverFlavors();
    const changed = flavorsChanged(this.cachedFlavors, flavors);
    setAgentFlavors("claude", flavors);
    this.cachedFlavors = flavors;
    if (changed || this.pendingBroadcast) {
      this.pendingBroadcast = false;
      try {
        broadcastToRenderer(CHANNELS.AGENT_FLAVORS_UPDATED, {
          agentId: "claude",
          flavors,
        });
      } catch {
        // Broadcast may fail during shutdown or before windows are ready
      }
    }
    return flavors;
  }

  async discoverFlavors(): Promise<AgentFlavor[]> {
    try {
      const raw = await readFile(CCR_CONFIG_PATH, "utf-8");
      const config: CcrConfig = JSON.parse(raw);

      if (!Array.isArray(config.models) || config.models.length === 0) {
        return [];
      }

      return config.models
        .filter((entry) => entry.id || entry.model)
        .map((entry) => this.entryToFlavor(entry));
    } catch {
      return [];
    }
  }

  getFlavors(): AgentFlavor[] {
    return this.cachedFlavors ?? [];
  }

  startWatching(): void {
    if (this.watchAbortController) return;

    this.watchAbortController = new AbortController();
    const { signal } = this.watchAbortController;

    const poll = async () => {
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        if (signal.aborted) break;
        await this.loadAndApply();
      }
    };

    void poll().catch(() => {});
  }

  stopWatching(): void {
    this.watchAbortController?.abort();
    this.watchAbortController = null;
  }

  private entryToFlavor(entry: CcrModelEntry): AgentFlavor {
    const id = entry.id ?? entry.model ?? "unknown";
    const name = entry.name ?? entry.model ?? id;
    const env: Record<string, string> = {};

    if (entry.model) {
      env.ANTHROPIC_MODEL = entry.model;
    }
    if (entry.baseUrl) {
      env.ANTHROPIC_BASE_URL = entry.baseUrl;
    }
    if (entry.apiKeyEnv) {
      env.ANTHROPIC_API_KEY = `\${${entry.apiKeyEnv}}`;
    }

    return {
      id: `ccr-${id}`,
      name: `CCR: ${name}`,
      description: `Routed via Claude Code Router (${id})`,
      env: Object.keys(env).length > 0 ? env : undefined,
    };
  }
}
