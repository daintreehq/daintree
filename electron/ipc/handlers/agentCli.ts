import { CHANNELS } from "../channels.js";
import { getAgentIds } from "../../../shared/config/agentRegistry.js";
import type {
  AgentAvailabilityState,
  AgentInstallPayload,
} from "../../../shared/types/ipc/system.js";
import { sendToRenderer, typedHandle, typedHandleWithContext } from "../utils.js";
import { runAgentInstall } from "../../services/AgentInstallService.js";
import type { HandlerDependencies } from "../types.js";

export function registerAgentCliHandlers(deps: HandlerDependencies): () => void {
  const { cliAvailabilityService, agentVersionService, agentUpdateHandler } = deps;
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

  const handleSystemGetAgentVersions = async () => {
    if (!agentVersionService) {
      console.warn("[IPC] AgentVersionService not available");
      return [];
    }

    return await agentVersionService.getVersions();
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_GET_AGENT_VERSIONS, handleSystemGetAgentVersions));

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

  const handleSystemStartAgentUpdate = async (
    payload: import("../../types/index.js").StartAgentUpdatePayload
  ) => {
    if (!agentUpdateHandler) {
      throw new Error("AgentUpdateHandler not available");
    }

    if (
      !payload ||
      !payload.agentId ||
      typeof payload.agentId !== "string" ||
      (payload.method !== undefined && typeof payload.method !== "string")
    ) {
      throw new Error("Invalid StartAgentUpdatePayload");
    }

    return await agentUpdateHandler.startUpdate(payload);
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_START_AGENT_UPDATE, handleSystemStartAgentUpdate));

  const handleSystemHealthCheck = async (agentIds?: string[]) => {
    const { runSystemHealthCheck } = await import("../../services/SystemHealthCheck.js");
    return await runSystemHealthCheck(agentIds);
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
    const { checkPrerequisite } = await import("../../services/SystemHealthCheck.js");
    return new Promise<import("../../../shared/types/ipc/system.js").PrerequisiteCheckResult>(
      (resolve) => {
        setImmediate(() => resolve(checkPrerequisite(spec)));
      }
    );
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_CHECK_TOOL, handleSystemCheckTool));

  const handleSetupAgentInstall = async (
    ctx: import("../types.js").IpcContext,
    payload: AgentInstallPayload
  ) => {
    const senderWindow = ctx.senderWindow;

    if (
      !payload ||
      !payload.agentId ||
      typeof payload.agentId !== "string" ||
      !payload.jobId ||
      typeof payload.jobId !== "string"
    ) {
      throw new Error("Invalid AgentInstallPayload");
    }

    return await runAgentInstall(payload, (progressEvent) => {
      if (senderWindow) {
        sendToRenderer(senderWindow, CHANNELS.SETUP_AGENT_INSTALL_PROGRESS, progressEvent);
      }
    });
  };
  handlers.push(typedHandleWithContext(CHANNELS.SETUP_AGENT_INSTALL, handleSetupAgentInstall));

  return () => handlers.forEach((cleanup) => cleanup());
}
