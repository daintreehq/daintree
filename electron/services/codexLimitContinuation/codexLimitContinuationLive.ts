import { powerMonitor } from "electron";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToProjectRenderers } from "../../ipc/utils.js";
import { store } from "../../store.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { events } from "../events.js";
import { projectStore } from "../ProjectStore.js";
import type { PtyIncarnationExit, PtyIncarnationLost } from "../PtyClient.js";
import type { SpawnResult } from "../../../shared/types/pty-host.js";
import { readCodexLimitStop } from "../codex/CodexLimitReset.js";
import type { AgentSettings } from "../../../shared/types/agentSettings.js";
import type { AgentPreset } from "../../../shared/config/agentRegistry.js";
import type { CodexLimitStopRef } from "../../../shared/types/codexLimitContinuation.js";
import { CodexLimitContinuation, type ContinuationTerminal } from "./CodexLimitContinuation.js";
import {
  decideLimitFallback,
  limitFallbackOptIn,
  limitResetOptIn,
  type LimitFallback,
} from "./limitFallback.js";
import { setContinuationPaneForgetter } from "./forgetPane.js";

async function readTerminal(terminalId: string): Promise<ContinuationTerminal | null> {
  const pty = getPtyClient();
  if (!pty) return null;
  const info = await pty.getTerminalAsync(terminalId, undefined, { strict: true });
  if (!info) return null;
  return {
    projectId: info.projectId,
    launchAgentId: info.launchAgentId,
    detectedAgentId: info.detectedAgentId,
    agentPresetId: info.agentPresetId,
    originalAgentPresetId: info.originalAgentPresetId,
    fallbackChainIndex: info.fallbackChainIndex,
    isAssistantTerminal: info.isAssistantTerminal === true,
    spawnedAt: info.spawnedAt,
  };
}

/** The project's own presets for `agentId`, or null when they couldn't be read. */
async function readProjectPresets(
  projectId: string | undefined,
  agentId: string
): Promise<AgentPreset[] | undefined | null> {
  const project = projectId === undefined ? null : projectStore.getProjectById(projectId);
  if (!project) return null;
  try {
    const byAgent = await projectStore.readInRepoPresets(project.path);
    return Object.hasOwn(byAgent, agentId) && Array.isArray(byAgent[agentId])
      ? byAgent[agentId]
      : undefined;
  } catch {
    return null;
  }
}

/** Read from this machine's settings and the project's files: the pane's host decides. */
async function decideFallback(terminal: ContinuationTerminal): Promise<LimitFallback> {
  const agentId = terminal.launchAgentId;
  if (agentId === undefined || terminal.agentPresetId === undefined) return "none";
  const run = {
    agentId,
    presetId: terminal.agentPresetId,
    originalPresetId: terminal.originalAgentPresetId,
    chainIndex: terminal.fallbackChainIndex,
  };
  let customPresets: AgentPreset[] | undefined | null;
  try {
    const settings = store.get("agentSettings") as AgentSettings | undefined;
    customPresets = settings?.agents?.[agentId]?.customPresets;
  } catch {
    customPresets = null;
  }
  // The project's presets matter only for a chain the user opted in to.
  const projectPresets =
    customPresets !== null && limitFallbackOptIn(run, customPresets) !== null
      ? await readProjectPresets(terminal.projectId, agentId)
      : undefined;
  return decideLimitFallback(run, customPresets, projectPresets);
}

/** The user's own presets of `agentId` on this machine, or undefined when unread. */
function readOwnPresets(agentId: string): AgentPreset[] | undefined {
  try {
    const settings = store.get("agentSettings") as AgentSettings | undefined;
    return settings?.agents?.[agentId]?.customPresets;
  } catch {
    return undefined;
  }
}

let service: CodexLimitContinuation | null = null;
let stopListening: (() => void) | null = null;

/** A launch of an agent a pane can be armed for, as the spawn handler sent it. */
export interface AgentLaunchForContinuation {
  terminalId: string;
  projectId: string;
  launchGeneration: number;
  agentId: string;
  presetId: string | undefined;
  originalPresetId: string | undefined;
}

/**
 * Called by the spawn handler right after it sent a launch (#17912): the pane
 * starts armed when its user's own original preset says so, unless the user
 * chose otherwise for it, once the host confirms the spawn. A launch whose
 * preset doesn't arm it, of a pane nothing has armed, creates nothing.
 */
export function noteContinuationLaunch(launch: AgentLaunchForContinuation): void {
  const arms =
    launch.presetId !== undefined &&
    limitResetOptIn(
      {
        agentId: launch.agentId,
        presetId: launch.presetId,
        originalPresetId: launch.originalPresetId,
      },
      readOwnPresets(launch.agentId)
    );
  if (!arms && !service?.isArmed(launch.terminalId)) return;
  getCodexLimitContinuation().noteLaunch({
    terminalId: launch.terminalId,
    projectId: launch.projectId,
    launchGeneration: launch.launchGeneration,
    arms,
  });
}

/**
 * Follows the facts armed panes act on, only while one is armed: with none,
 * Daintree pays nothing for this feature.
 */
function startListening(target: CodexLimitContinuation): void {
  if (stopListening) return;
  const ptyClient = getPtyClient();
  const onStop = (fact: { terminalId: string } & CodexLimitStopRef) =>
    void target.handleStop(fact.terminalId, { run: fact.run, seq: fact.seq });
  const onSpawn = (terminalId: string, result: SpawnResult) =>
    target.handleSpawnResult(terminalId, result);
  const onExit = (fact: PtyIncarnationExit) =>
    target.handleProcessChange(fact.terminalId, fact.spawnedAt);
  const onLost = (fact: PtyIncarnationLost) => target.handleProcessChange(fact.terminalId);
  const onTerminalLost = (terminalId: string) => target.handleProcessChange(terminalId);
  const offAgentExit = events.on("agent:exited", (payload) =>
    target.handleProcessChange(payload.terminalId)
  );
  // The raw event: a wait whose time passed in sleep is judged once the
  // machine is back and its terminals are read again, through the same checks.
  const onResume = () => target.handleWake();
  ptyClient?.on("codex-limit-stopped", onStop);
  ptyClient?.on("spawn-result", onSpawn);
  ptyClient?.on("incarnation-exit", onExit);
  ptyClient?.on("incarnation-lost", onLost);
  ptyClient?.on("terminal-lost", onTerminalLost);
  powerMonitor.on("resume", onResume);
  stopListening = () => {
    ptyClient?.off("codex-limit-stopped", onStop);
    ptyClient?.off("spawn-result", onSpawn);
    ptyClient?.off("incarnation-exit", onExit);
    ptyClient?.off("incarnation-lost", onLost);
    ptyClient?.off("terminal-lost", onTerminalLost);
    offAgentExit();
    powerMonitor.off("resume", onResume);
  };
}

export function getCodexLimitContinuation(): CodexLimitContinuation {
  if (service) return service;
  const created: CodexLimitContinuation = new CodexLimitContinuation({
    now: () => Date.now(),
    readTerminal,
    readStop: (terminalId) => readCodexLimitStop(terminalId),
    decideFallback,
    continueAt: async (terminalId, stop) => {
      const pty = getPtyClient();
      if (!pty) throw new Error("No pty host");
      return pty.continueCodexLimitAsync(terminalId, stop);
    },
    setHostArmed: (terminalId, armed) => getPtyClient()?.setCodexLimitContinue(terminalId, armed),
    notify: (projectId, change) =>
      broadcastToProjectRenderers(projectId, CHANNELS.CODEX_LIMIT_CONTINUE_CHANGED, change),
    setTimer: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    },
    clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
    onActiveChange: (active) => {
      if (active) {
        startListening(created);
        return;
      }
      stopListening?.();
      stopListening = null;
    },
  });
  service = created;
  setContinuationPaneForgetter((terminalId) => created.forgetPane(terminalId));
  return created;
}

/** The service if anything has used it, for readers that must not create it. */
export function peekCodexLimitContinuation(): CodexLimitContinuation | null {
  return service;
}

/** @internal Tests only. */
export function _resetCodexLimitContinuationForTest(): void {
  service?.dispose();
  stopListening?.();
  stopListening = null;
  service = null;
  setContinuationPaneForgetter(null);
}
