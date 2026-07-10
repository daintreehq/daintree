import type { SlashCommand } from "../../shared/types/index.js";
import { CompletionDiscoveryEngine } from "./completions/CompletionDiscoveryEngine.js";

/**
 * Thin compatibility facade over {@link CompletionDiscoveryEngine}. Keeps the
 * `slashCommands.list` IPC surface (`agentId` + `projectPath` → `SlashCommand[]`)
 * unchanged while completion discovery is driven generically by each agent's
 * declarative `completionSources` (see `shared/types/completionSources.ts`).
 */
export class SlashCommandService {
  constructor(
    private readonly engine: CompletionDiscoveryEngine = new CompletionDiscoveryEngine()
  ) {}

  list(agentId: SlashCommand["agentId"], projectPath?: string): Promise<SlashCommand[]> {
    return this.engine.list(agentId, projectPath);
  }

  /** Drop cached discovery results (used by tests and on registry changes). */
  clearCache(): void {
    this.engine.clearCache();
  }
}

export const slashCommandService = new SlashCommandService();
