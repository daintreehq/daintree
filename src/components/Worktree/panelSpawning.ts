import { usePanelStore } from "@/store/panelStore";
import { agentSettingsClient, systemClient } from "@/clients";
import { getAgentConfig } from "@/config/agents";
import { generateAgentCommand } from "@shared/types";
import type { RecipeTerminal } from "@shared/types";

export interface SpawnPanelsOptions {
  terminals: RecipeTerminal[];
  worktreeId: string;
  cwd: string;
  /** Pre-fetched agent settings. When omitted and agent panels are present, fetched internally. */
  agentSettings?: Awaited<ReturnType<typeof agentSettingsClient.get>> | null;
  /** Pre-fetched clipboard directory. Only meaningful with agentSettings. */
  clipboardDirectory?: string;
  signal?: AbortSignal;
  onPanelSpawned?: (index: number, panelId: string | null, error?: unknown) => void;
}

export async function spawnPanelsFromRecipe(options: SpawnPanelsOptions): Promise<void> {
  const { terminals, worktreeId, cwd, signal, onPanelSpawned } = options;

  const hasAgent = terminals.some((t) => t.type !== "terminal" && t.type !== "dev-preview");

  let agentSettings = options.agentSettings;
  let clipboardDirectory = options.clipboardDirectory;

  // Fallback pre-fetch when caller didn't provide settings
  if (agentSettings === undefined && hasAgent) {
    try {
      const [settings, tmpDir] = await Promise.all([
        agentSettingsClient.get(),
        systemClient.getTmpDir().catch(() => ""),
      ]);
      if (signal?.aborted) return;
      agentSettings = settings;
      clipboardDirectory = tmpDir ? `${tmpDir}/daintree-clipboard` : undefined;
    } catch {
      if (signal?.aborted) return;
    }
  }

  const errors: { index: number; error: unknown }[] = [];

  for (const [index, t] of terminals.entries()) {
    if (signal?.aborted) return;

    try {
      let panelId: string | null;

      if (t.type === "dev-preview") {
        panelId = await usePanelStore.getState().addPanel({
          kind: "dev-preview",
          title: t.title,
          cwd,
          worktreeId,
          exitBehavior: t.exitBehavior,
          devCommand: t.devCommand?.trim() || undefined,
        });
      } else if (t.type !== "terminal") {
        const agentId = t.type;
        const agentConfig = getAgentConfig(agentId);
        const baseCommand = agentConfig?.command ?? "";
        const entry = agentSettings?.agents?.[agentId] ?? {};
        const command = generateAgentCommand(baseCommand, entry, agentId, {
          clipboardDirectory,
          modelId: t.agentModelId,
        });

        panelId = await usePanelStore.getState().addPanel({
          kind: "terminal",
          launchAgentId: agentId,
          command,
          title: t.title,
          cwd,
          worktreeId,
          exitBehavior: t.exitBehavior,
          agentModelId: t.agentModelId,
          agentLaunchFlags: t.agentLaunchFlags,
        });
      } else {
        panelId = await usePanelStore.getState().addPanel({
          kind: "terminal",
          title: t.title,
          cwd,
          worktreeId,
          exitBehavior: t.exitBehavior,
          command: t.command?.trim() || undefined,
        });
      }

      if (panelId != null) {
        try {
          onPanelSpawned?.(index, panelId);
        } catch {
          // Callback threw — it already fired once, nothing to do.
        }
      } else {
        const err = new Error("addPanel returned null");
        if (onPanelSpawned) {
          onPanelSpawned(index, null, err);
        } else {
          errors.push({ index, error: err });
        }
      }
    } catch (err) {
      if (onPanelSpawned) {
        onPanelSpawned(index, null, err);
      } else {
        errors.push({ index, error: err });
      }
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(
      errors.map((e) => e.error),
      `${errors.length} panel(s) failed to spawn`
    );
  }
}
