// eager-import-allow: reads agent CLI config via store.get synchronously in the IPC handler
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { AGENT_CLI_COPIES_METHOD_CHANNELS } from "./agentCliCopies.preload.js";
import { getAgentIds, getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import type {
  AgentAvailabilityState,
  AgentCliCopy,
  AgentCliDetails,
  AgentInstallPayload,
} from "../../../shared/types/ipc/system.js";
import {
  broadcastToRenderer,
  sendToRendererContext,
  typedHandle,
  typedHandleWithContext,
} from "../utils.js";
import { runAgentInstall } from "../../services/AgentInstallService.js";
import type { HandlerDependencies } from "../types.js";

export function registerAgentCliHandlers(deps: HandlerDependencies): () => void {
  const { cliAvailabilityService, agentVersionService } = deps;
  const handlers: Array<() => void> = [];

  const handleSystemGetCliAvailability = async () => {
    if (!cliAvailabilityService) {
      console.warn("[IPC] CliAvailabilityService not available");
      return Object.fromEntries(
        getAgentIds().map((id) => [id, "missing" as AgentAvailabilityState])
      );
    }

    const cached = cliAvailabilityService.getAvailability();
    if (cached) {
      return cached;
    }

    return await cliAvailabilityService.checkAvailability();
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_GET_CLI_AVAILABILITY, handleSystemGetCliAvailability));

  const handleSystemRefreshCliAvailability = async () => {
    if (!cliAvailabilityService) {
      console.warn("[IPC] CliAvailabilityService not available");
      return Object.fromEntries(
        getAgentIds().map((id) => [id, "missing" as AgentAvailabilityState])
      );
    }

    return await cliAvailabilityService.refresh();
  };
  handlers.push(
    typedHandle(CHANNELS.SYSTEM_REFRESH_CLI_AVAILABILITY, handleSystemRefreshCliAvailability)
  );

  const handleSystemGetAgentCliDetails = async (): Promise<AgentCliDetails> => {
    if (!cliAvailabilityService) {
      console.warn("[IPC] CliAvailabilityService not available");
      return {};
    }

    let details = cliAvailabilityService.getDetails();
    if (!details) {
      // Details are populated by the same cycle as availability. If nothing
      // is cached yet, kick off the check so renderers can lazy-load the
      // diagnostics surface without a second probe pass.
      await cliAvailabilityService.checkAvailability();
      details = cliAvailabilityService.getDetails();
    }
    return details ?? {};
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_GET_AGENT_CLI_DETAILS, handleSystemGetAgentCliDetails));

  const handleSystemGetAgentVersions = async () => {
    if (!agentVersionService) {
      console.warn("[IPC] AgentVersionService not available");
      return [];
    }

    return await agentVersionService.getVersions();
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_GET_AGENT_VERSIONS, handleSystemGetAgentVersions));

  const handleSystemGetAgentVersion = async (agentId: string, refresh?: boolean) => {
    if (typeof agentId !== "string" || !agentId) {
      throw new Error("Invalid agentId");
    }

    if (!agentVersionService) {
      console.warn("[IPC] AgentVersionService not available");
      return {
        agentId: agentId as import("../../../shared/types/agent.js").AgentId,
        installedVersion: null,
        latestVersion: null,
        updateAvailable: false,
        lastChecked: null,
      };
    }

    return await agentVersionService.getVersion(
      agentId as import("../../../shared/types/agent.js").AgentId,
      refresh === true
    );
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_GET_AGENT_VERSION, handleSystemGetAgentVersion));

  const handleSystemRefreshAgentVersions = async () => {
    if (!agentVersionService) {
      console.warn("[IPC] AgentVersionService not available");
      return [];
    }

    return await agentVersionService.getVersions(true);
  };
  handlers.push(
    typedHandle(CHANNELS.SYSTEM_REFRESH_AGENT_VERSIONS, handleSystemRefreshAgentVersions)
  );

  // Every later launch, version and listing reads the choice through a check that
  // has already seen it, and every view hears that it changed.
  const applyCliChoice = async (agentId: string, path: string | null): Promise<void> => {
    if (!cliAvailabilityService) throw new Error("CLI detection isn't available");
    cliAvailabilityService.setChosenCopy(agentId, path);
    agentVersionService?.invalidate(agentId);
    try {
      await cliAvailabilityService.refresh();
    } finally {
      broadcastToRenderer(CHANNELS.AGENT_CLI_COPIES_CHANGED, { agentId });
    }
  };

  const agentCliCopiesNamespace = defineIpcNamespace({
    name: "agentCliCopies",
    ops: {
      // Takes only an agent id: which files run is this machine's to decide.
      list: op(
        AGENT_CLI_COPIES_METHOD_CHANNELS.list,
        async (agentId: string): Promise<AgentCliCopy[]> => {
          if (typeof agentId !== "string" || !agentId) {
            throw new Error("Invalid agentId");
          }
          return (await agentVersionService?.getCopies(agentId)) ?? [];
        }
      ),
      // Only a copy this machine finds now can be chosen: a path the caller names
      // is a key into that list, never a command of its own.
      choose: op(
        AGENT_CLI_COPIES_METHOD_CHANNELS.choose,
        async (agentId: string, path: string): Promise<void> => {
          if (typeof agentId !== "string" || !agentId) {
            throw new Error("Invalid agentId");
          }
          if (typeof path !== "string" || !path) {
            throw new Error("Invalid path");
          }
          if (!cliAvailabilityService) throw new Error("CLI detection isn't available");
          const config = getEffectiveAgentConfig(agentId);
          if (!config) throw new Error(`Unknown agent: ${agentId}`);
          const found = await cliAvailabilityService.findCopies(agentId, config);
          const copy = found.find((candidate) => candidate === path);
          if (copy === undefined) {
            throw new Error("That copy wasn't found on this machine. Re-check and choose again.");
          }
          await applyCliChoice(agentId, copy);
        }
      ),
      reset: op(AGENT_CLI_COPIES_METHOD_CHANNELS.reset, async (agentId: string): Promise<void> => {
        if (typeof agentId !== "string" || !agentId) {
          throw new Error("Invalid agentId");
        }
        if (!getEffectiveAgentConfig(agentId)) throw new Error(`Unknown agent: ${agentId}`);
        await applyCliChoice(agentId, null);
      }),
    },
  });
  handlers.push(agentCliCopiesNamespace.register());

  const handleSystemGetAgentUpdateSettings = async () => {
    const { store } = await import("../../store.js");
    return store.get("agentUpdateSettings", {
      autoCheck: true,
      checkFrequencyHours: 24,
      lastAutoCheck: null,
    });
  };
  handlers.push(
    typedHandle(CHANNELS.SYSTEM_GET_AGENT_UPDATE_SETTINGS, handleSystemGetAgentUpdateSettings)
  );

  const handleSystemSetAgentUpdateSettings = async (
    settings: import("../../types/index.js").AgentUpdateSettings
  ) => {
    if (
      !settings ||
      typeof settings.autoCheck !== "boolean" ||
      typeof settings.checkFrequencyHours !== "number" ||
      !Number.isFinite(settings.checkFrequencyHours) ||
      settings.checkFrequencyHours < 1 ||
      settings.checkFrequencyHours > 168 ||
      (settings.lastAutoCheck !== null &&
        (typeof settings.lastAutoCheck !== "number" || !Number.isFinite(settings.lastAutoCheck)))
    ) {
      throw new Error("Invalid AgentUpdateSettings");
    }

    const { store } = await import("../../store.js");
    store.set("agentUpdateSettings", settings);
  };
  handlers.push(
    typedHandle(CHANNELS.SYSTEM_SET_AGENT_UPDATE_SETTINGS, handleSystemSetAgentUpdateSettings)
  );

  const handleSystemHealthCheck = async (
    options?: import("../../../shared/types/ipc/system.js").SystemHealthCheckOptions
  ) => {
    const { runSystemHealthCheck } = await import("../../services/SystemHealthCheck.js");
    return await runSystemHealthCheck(options);
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_HEALTH_CHECK, handleSystemHealthCheck));

  const handleSystemHealthCheckSpecs = async (agentIds?: string[]) => {
    const { getHealthCheckSpecs } = await import("../../services/SystemHealthCheck.js");
    return await getHealthCheckSpecs(agentIds);
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_HEALTH_CHECK_SPECS, handleSystemHealthCheckSpecs));

  const handleSystemCheckTool = async (
    spec: import("../../../shared/types/ipc/system.js").PrerequisiteSpec
  ) => {
    const { checkPrerequisite, isShellInertInvocation } =
      await import("../../services/SystemHealthCheck.js");

    // The spec names a binary and the flags main will execute, so it is checked
    // here rather than trusted: on Windows a `.cmd` shim has to be spawned
    // through cmd.exe, which parses whatever it is handed.
    if (
      !spec ||
      typeof spec.tool !== "string" ||
      !spec.tool ||
      (spec.command !== undefined && typeof spec.command !== "string") ||
      !isShellInertInvocation(spec.command ?? spec.tool, spec.versionArgs)
    ) {
      throw new Error("Invalid PrerequisiteSpec");
    }

    return await checkPrerequisite(spec);
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_CHECK_TOOL, handleSystemCheckTool));

  const handleSetupAgentInstall = async (
    ctx: import("../types.js").IpcContext,
    payload: AgentInstallPayload
  ) => {
    const hasAgentId = typeof payload?.agentId === "string" && payload.agentId.length > 0;
    const hasPrerequisiteTool =
      typeof payload?.prerequisiteTool === "string" && payload.prerequisiteTool.length > 0;

    // Exactly one target — a payload naming both is ambiguous about which
    // command list main should resolve, so it's rejected rather than guessed.
    if (
      !payload ||
      hasAgentId === hasPrerequisiteTool ||
      !payload.jobId ||
      typeof payload.jobId !== "string"
    ) {
      throw new Error("Invalid AgentInstallPayload");
    }

    return await runAgentInstall(payload, (progressEvent) => {
      sendToRendererContext(ctx, CHANNELS.SETUP_AGENT_INSTALL_PROGRESS, progressEvent);
    });
  };
  handlers.push(
    // @ts-expect-error: result type contains forbidden envelope key — pending migration to throw AppError. See #6020.
    typedHandleWithContext(CHANNELS.SETUP_AGENT_INSTALL, handleSetupAgentInstall)
  );

  return () => handlers.forEach((cleanup) => cleanup());
}
