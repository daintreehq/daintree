import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { getAgentIds } from "../../../shared/config/agentRegistry.js";
import type {
  AgentAvailabilityState,
  AgentInstallPayload,
} from "../../../shared/types/ipc/system.js";
import { sendToRenderer } from "../utils.js";
import { getWindowForWebContents } from "../../window/webContentsRegistry.js";
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
  ipcMain.handle(CHANNELS.SYSTEM_GET_CLI_AVAILABILITY, handleSystemGetCliAvailability);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_GET_CLI_AVAILABILITY));

  const handleSystemRefreshCliAvailability = async () => {
    if (!cliAvailabilityService) {
      console.warn("[IPC] CliAvailabilityService not available");
      return Object.fromEntries(
        getAgentIds().map((id) => [id, "missing" as AgentAvailabilityState])
      );
    }

    return await cliAvailabilityService.refresh();
  };
  ipcMain.handle(CHANNELS.SYSTEM_REFRESH_CLI_AVAILABILITY, handleSystemRefreshCliAvailability);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_REFRESH_CLI_AVAILABILITY));

  const handleSystemGetAgentVersions = async () => {
    if (!agentVersionService) {
      console.warn("[IPC] AgentVersionService not available");
      return [];
    }

    return await agentVersionService.getVersions();
  };
  ipcMain.handle(CHANNELS.SYSTEM_GET_AGENT_VERSIONS, handleSystemGetAgentVersions);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_GET_AGENT_VERSIONS));

  const handleSystemRefreshAgentVersions = async () => {
    if (!agentVersionService) {
      console.warn("[IPC] AgentVersionService not available");
      return [];
    }

    return await agentVersionService.getVersions(true);
  };
  ipcMain.handle(CHANNELS.SYSTEM_REFRESH_AGENT_VERSIONS, handleSystemRefreshAgentVersions);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_REFRESH_AGENT_VERSIONS));

  const handleSystemGetAgentUpdateSettings = async () => {
    const { store } = await import("../../store.js");
    return store.get("agentUpdateSettings", {
      autoCheck: true,
      checkFrequencyHours: 24,
      lastAutoCheck: null,
    });
  };
  ipcMain.handle(CHANNELS.SYSTEM_GET_AGENT_UPDATE_SETTINGS, handleSystemGetAgentUpdateSettings);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_GET_AGENT_UPDATE_SETTINGS));

  const handleSystemSetAgentUpdateSettings = async (
    _event: Electron.IpcMainInvokeEvent,
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
  ipcMain.handle(CHANNELS.SYSTEM_SET_AGENT_UPDATE_SETTINGS, handleSystemSetAgentUpdateSettings);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_SET_AGENT_UPDATE_SETTINGS));

  const handleSystemStartAgentUpdate = async (
    _event: Electron.IpcMainInvokeEvent,
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
  ipcMain.handle(CHANNELS.SYSTEM_START_AGENT_UPDATE, handleSystemStartAgentUpdate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_START_AGENT_UPDATE));

  const handleSystemHealthCheck = async (
    _event: Electron.IpcMainInvokeEvent,
    agentIds?: string[]
  ) => {
    const { runSystemHealthCheck } = await import("../../services/SystemHealthCheck.js");
    return await runSystemHealthCheck(agentIds);
  };
  ipcMain.handle(CHANNELS.SYSTEM_HEALTH_CHECK, handleSystemHealthCheck);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_HEALTH_CHECK));

  const handleSystemHealthCheckSpecs = async (
    _event: Electron.IpcMainInvokeEvent,
    agentIds?: string[]
  ) => {
    const { getHealthCheckSpecs } = await import("../../services/SystemHealthCheck.js");
    return await getHealthCheckSpecs(agentIds);
  };
  ipcMain.handle(CHANNELS.SYSTEM_HEALTH_CHECK_SPECS, handleSystemHealthCheckSpecs);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_HEALTH_CHECK_SPECS));

  const handleSystemCheckTool = async (
    _event: Electron.IpcMainInvokeEvent,
    spec: import("../../../shared/types/ipc/system.js").PrerequisiteSpec
  ) => {
    const { checkPrerequisite } = await import("../../services/SystemHealthCheck.js");
    return new Promise<import("../../../shared/types/ipc/system.js").PrerequisiteCheckResult>(
      (resolve) => {
        setImmediate(() => resolve(checkPrerequisite(spec)));
      }
    );
  };
  ipcMain.handle(CHANNELS.SYSTEM_CHECK_TOOL, handleSystemCheckTool);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_CHECK_TOOL));

  const handleSetupAgentInstall = async (
    event: Electron.IpcMainInvokeEvent,
    payload: AgentInstallPayload
  ) => {
    const senderWindow = getWindowForWebContents(event.sender);

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
  ipcMain.handle(CHANNELS.SETUP_AGENT_INSTALL, handleSetupAgentInstall);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SETUP_AGENT_INSTALL));

  return () => handlers.forEach((cleanup) => cleanup());
}
