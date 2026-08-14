import { usePanelStore } from "@/store/panelStore";
import { agentSettingsClient, systemClient } from "@/clients";
import { getAgentConfig } from "@/config/agents";
import { generateAgentCommand, buildAgentLaunchFlags, mintAssignedSessionId } from "@shared/types";
import type { RecipeTerminal } from "@shared/types";
import { preflightSpawnBatchLimit } from "@/store/panelLimitStore";
import { isMcpSpawnFocusSuppressed } from "@/store/mcpSpawnFocusGuard";
import { isAssistantFocused } from "@/store/macroFocusStore";
import { countPanelsTowardLimit } from "@/store/slices/panelRegistry/panelCount";

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

  if (signal?.aborted) return;

  const store = usePanelStore.getState();

  // Aggregate panel-limit gate before opening the batch. The batched `addPanel`
  // path defers the `panelIds` append, so per-call limit checks would all read
  // the same stale count; gate the whole burst once and pass `bypassLimits` on
  // each call. (#9165)
  const currentCount = countPanelsTowardLimit(store.panelsById, store.panelIds);
  const { allowed } = await preflightSpawnBatchLimit(currentCount, terminals.length);
  if (signal?.aborted) return;

  const errors: { index: number; error: unknown }[] = [];

  // Panels beyond the resolved limit can't spawn — report them as failures.
  for (let index = allowed; index < terminals.length; index++) {
    const err = new Error("Panel limit reached");
    if (onPanelSpawned) {
      onPanelSpawned(index, null, err);
    } else {
      errors.push({ index, error: err });
    }
  }

  // Capture focus intent before the batch (the batched path suppresses the
  // per-panel focus mutation that would otherwise focus the last grid panel).
  const suppressFocus = isMcpSpawnFocusSuppressed() || isAssistantFocused();

  type Outcome = { index: number; panelId: string | null; error?: unknown; skipped?: boolean };

  // One batch for the whole burst: each `addPanel` commits `panelsById`
  // immediately but defers the `panelIds` append, collapsing N grid reflows
  // into one at flush. Skip opening it when the limit leaves no room. (#9165)
  const batchToken = allowed > 0 ? store.beginSpawnBatch() : null;
  let outcomes: Outcome[];
  try {
    outcomes = await Promise.all(
      terminals.slice(0, allowed).map(async (t, index): Promise<Outcome> => {
        // Re-check between (parallel) dispatches: a synchronous abort from an
        // earlier panel's spawn still stops later panels from being created.
        if (signal?.aborted) return { index, panelId: null, skipped: true };

        try {
          let panelId: string | null;

          if (t.type === "dev-preview") {
            panelId = await store.addPanel({
              kind: "dev-preview",
              title: t.title,
              cwd,
              worktreeId,
              exitBehavior: t.exitBehavior,
              devCommand: t.devCommand?.trim() || undefined,
              location: t.location,
              bypassLimits: true,
            });
          } else if (t.type !== "terminal") {
            const agentId = t.type;
            const agentConfig = getAgentConfig(agentId);
            const baseCommand = agentConfig?.command ?? "";
            const entry = agentSettings?.agents?.[agentId] ?? {};
            const globalSkipPermissions = agentSettings?.globalSkipPermissions ?? false;
            const globalUseAltScreen = agentSettings?.globalUseAltScreen ?? false;
            // One id per spawned pane (#11782) — a recipe fans out several
            // panes at once, and reusing an id across them would collide.
            const assignedSessionId = mintAssignedSessionId(agentId);
            const command = generateAgentCommand(baseCommand, entry, agentId, {
              clipboardDirectory,
              modelId: t.agentModelId,
              recipeArgs: t.args?.trim() || undefined,
              globalSkipPermissions,
              globalUseAltScreen,
              sessionId: assignedSessionId,
            });
            // Preserve flags the caller already captured (the clone-layout path
            // projects a live panel's `agentLaunchFlags` onto the recipe). For
            // disk recipes the field is stripped (undefined), so compute from
            // live settings instead — persisting these lets restart/resume
            // reproduce the launch and prevents `--dangerously-skip-permissions`
            // and recipe args from being dropped on resume (#9650). Recipe args
            // append as raw tokens.
            const agentLaunchFlags = t.agentLaunchFlags ?? [
              ...buildAgentLaunchFlags(entry, agentId, {
                modelId: t.agentModelId,
                globalSkipPermissions,
                globalUseAltScreen,
              }),
              ...(t.args?.trim().split(/\s+/).filter(Boolean) ?? []),
            ];

            panelId = await store.addPanel({
              kind: "terminal",
              launchAgentId: agentId,
              command,
              title: t.title,
              cwd,
              worktreeId,
              exitBehavior: t.exitBehavior,
              agentModelId: t.agentModelId,
              agentLaunchFlags,
              agentSessionId: assignedSessionId,
              location: t.location,
              bypassLimits: true,
            });
          } else {
            panelId = await store.addPanel({
              kind: "terminal",
              title: t.title,
              cwd,
              worktreeId,
              exitBehavior: t.exitBehavior,
              command: t.command?.trim() || undefined,
              location: t.location,
              bypassLimits: true,
            });
          }

          return { index, panelId };
        } catch (error) {
          return { index, panelId: null, error };
        }
      })
    );
  } finally {
    store.flushSpawnBatch(batchToken);
  }

  // Report in index order (parallel settle order is non-deterministic).
  let lastSpawnedId: string | null = null;
  for (const outcome of outcomes) {
    if (outcome.skipped) continue;

    if (outcome.error !== undefined) {
      if (onPanelSpawned) {
        onPanelSpawned(outcome.index, null, outcome.error);
      } else {
        errors.push({ index: outcome.index, error: outcome.error });
      }
      continue;
    }

    if (outcome.panelId != null) {
      // Dock panels land silently — only grid panels are focus candidates.
      if (terminals[outcome.index]?.location !== "dock") {
        lastSpawnedId = outcome.panelId;
      }
      try {
        onPanelSpawned?.(outcome.index, outcome.panelId);
      } catch {
        // Callback threw — it already fired once, nothing to do.
      }
    } else {
      const err = new Error("addPanel returned null");
      if (onPanelSpawned) {
        onPanelSpawned(outcome.index, null, err);
      } else {
        errors.push({ index: outcome.index, error: err });
      }
    }
  }

  // Restore the per-panel focus the batch suppressed: focus the last spawned
  // grid panel, matching the prior serial behaviour. An aborted batch skips it —
  // the dispatched panels can't be recalled, but yanking focus into work the
  // user just cancelled compounds it (#11517).
  if (!suppressFocus && lastSpawnedId !== null && !signal?.aborted) {
    // The batch suppressed addPanel's maximize exit along with its focus set, so
    // apply it here too — a spawned grid panel that takes focus has to be
    // visible, not stranded behind a fullscreen cell (#11060). Read the panel
    // back fresh (`store` is a pre-spawn snapshot) and require it to still be a
    // live grid panel: it can be removed during addPanel's async tail, and a
    // missing panel must not drop the user out of fullscreen.
    const committed = usePanelStore.getState().panelsById[lastSpawnedId];
    if (committed !== undefined && committed.location !== "dock") {
      store.exitMaximize();
    }
    store.setFocused(lastSpawnedId);
  }

  if (errors.length > 0) {
    throw new AggregateError(
      errors.map((e) => e.error),
      `${errors.length} panel(s) failed to spawn`
    );
  }
}
