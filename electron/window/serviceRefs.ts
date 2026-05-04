// Leaf module: zero runtime imports so every consumer can safely import
// from it without risking ESM TDZ during cold startup. Holds the global
// (cross-window) singleton refs that windowServices.ts and its extracted
// helpers (globalServicesInit, perWindowInit) read and mutate. Type-only
// imports are erased at compile time and cannot create circular runtime
// edges.
import type { PtyClient } from "../services/PtyClient.js";
import type { MainProcessWatchdogClient } from "../services/MainProcessWatchdogClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import type { CliAvailabilityService } from "../services/CliAvailabilityService.js";
import type { AgentVersionService } from "../services/AgentVersionService.js";
import type { AgentUpdateHandler } from "../services/AgentUpdateHandler.js";
import type { ResourceProfileService } from "../services/ResourceProfileService.js";
import type { WorktreePortBroker } from "../services/WorktreePortBroker.js";
import type { CcrConfigService } from "../services/CcrConfigService.js";
import type { autoUpdaterService as AutoUpdaterServiceType } from "../services/AutoUpdaterService.js";
import type { agentNotificationService as AgentNotificationServiceType } from "../services/AgentNotificationService.js";

// Guard: process.argv CLI path should only be consumed by the first window
let processArgvCliHandled = false;

// Guard: IPC handlers are globally scoped (ipcMain.handle throws on re-registration)
let ipcHandlersRegistered = false;

// Guard: one-time global initialization (migrations, GitHubAuth, etc.)
let globalServicesInitialized = false;

// ── Global service refs (shared across all windows) ──
let ptyClient: PtyClient | null = null;
let mainProcessWatchdogClient: MainProcessWatchdogClient | null = null;
let workspaceClient: WorkspaceClient | null = null;
let cliAvailabilityService: CliAvailabilityService | null = null;
let agentVersionService: AgentVersionService | null = null;
let agentUpdateHandler: AgentUpdateHandler | null = null;
let cleanupIpcHandlers: (() => void) | null = null;
let cleanupErrorHandlers: (() => void) | null = null;
let stopEventLoopLagMonitor: (() => void) | null = null;
let stopProcessMemoryMonitor: (() => void) | null = null;
let stopAppMetricsMonitor: (() => void) | null = null;
let stopDiskSpaceMonitor: (() => void) | null = null;
let resourceProfileService: ResourceProfileService | null = null;
let worktreePortBroker: WorktreePortBroker | null = null;
let ccrConfigService: CcrConfigService | null = null;

// Singletons resolved by deferred tasks. Held here so dispose paths can clean
// them up safely if the task ran. If the window closes before the task runs
// (early shutdown), these stay null and the dispose path no-ops.
let autoUpdaterServiceRef: typeof AutoUpdaterServiceType | null = null;
let agentNotificationServiceRef: typeof AgentNotificationServiceType | null = null;

// ── Public getters/setters (consumed by main.ts, menu.ts, shutdown.ts) ──
export function getPtyClient(): PtyClient | null {
  return ptyClient;
}
export function setPtyClientRef(v: PtyClient | null): void {
  ptyClient = v;
}
export function getMainProcessWatchdogClientRef(): MainProcessWatchdogClient | null {
  return mainProcessWatchdogClient;
}
export function setMainProcessWatchdogClientRef(v: MainProcessWatchdogClient | null): void {
  mainProcessWatchdogClient = v;
}
export function getWorkspaceClientRef(): WorkspaceClient | null {
  return workspaceClient;
}
export function setWorkspaceClientRef(v: WorkspaceClient | null): void {
  workspaceClient = v;
}
export function getWorktreePortBrokerRef(): WorktreePortBroker | null {
  return worktreePortBroker;
}
export function setWorktreePortBrokerRef(v: WorktreePortBroker | null): void {
  worktreePortBroker = v;
}
export function getCliAvailabilityServiceRef(): CliAvailabilityService | null {
  return cliAvailabilityService;
}
export function setCliAvailabilityServiceRef(v: CliAvailabilityService | null): void {
  cliAvailabilityService = v;
}
export function getCleanupIpcHandlers(): (() => void) | null {
  return cleanupIpcHandlers;
}
export function setCleanupIpcHandlers(v: (() => void) | null): void {
  cleanupIpcHandlers = v;
}
export function getCleanupErrorHandlers(): (() => void) | null {
  return cleanupErrorHandlers;
}
export function setCleanupErrorHandlers(v: (() => void) | null): void {
  cleanupErrorHandlers = v;
}
export function getStopEventLoopLagMonitor(): (() => void) | null {
  return stopEventLoopLagMonitor;
}
export function setStopEventLoopLagMonitor(v: (() => void) | null): void {
  stopEventLoopLagMonitor = v;
}
export function getStopProcessMemoryMonitor(): (() => void) | null {
  return stopProcessMemoryMonitor;
}
export function setStopProcessMemoryMonitor(v: (() => void) | null): void {
  stopProcessMemoryMonitor = v;
}
export function getStopAppMetricsMonitor(): (() => void) | null {
  return stopAppMetricsMonitor;
}
export function setStopAppMetricsMonitor(v: (() => void) | null): void {
  stopAppMetricsMonitor = v;
}
export function getStopDiskSpaceMonitor(): (() => void) | null {
  return stopDiskSpaceMonitor;
}
export function setStopDiskSpaceMonitor(v: (() => void) | null): void {
  stopDiskSpaceMonitor = v;
}

// ── Internal getters/setters (used across split modules) ──
export function getProcessArgvCliHandled(): boolean {
  return processArgvCliHandled;
}
export function setProcessArgvCliHandled(v: boolean): void {
  processArgvCliHandled = v;
}
export function getIpcHandlersRegistered(): boolean {
  return ipcHandlersRegistered;
}
export function setIpcHandlersRegistered(v: boolean): void {
  ipcHandlersRegistered = v;
}
export function getGlobalServicesInitialized(): boolean {
  return globalServicesInitialized;
}
export function setGlobalServicesInitialized(v: boolean): void {
  globalServicesInitialized = v;
}
export function getAgentVersionService(): AgentVersionService | null {
  return agentVersionService;
}
export function setAgentVersionService(v: AgentVersionService | null): void {
  agentVersionService = v;
}
export function getAgentUpdateHandler(): AgentUpdateHandler | null {
  return agentUpdateHandler;
}
export function setAgentUpdateHandler(v: AgentUpdateHandler | null): void {
  agentUpdateHandler = v;
}
export function getResourceProfileService(): ResourceProfileService | null {
  return resourceProfileService;
}
export function setResourceProfileService(v: ResourceProfileService | null): void {
  resourceProfileService = v;
}
export function getCcrConfigService(): CcrConfigService | null {
  return ccrConfigService;
}
export function setCcrConfigService(v: CcrConfigService | null): void {
  ccrConfigService = v;
}
export function getAutoUpdaterServiceRef(): typeof AutoUpdaterServiceType | null {
  return autoUpdaterServiceRef;
}
export function setAutoUpdaterServiceRef(v: typeof AutoUpdaterServiceType | null): void {
  autoUpdaterServiceRef = v;
}
export function getAgentNotificationServiceRef(): typeof AgentNotificationServiceType | null {
  return agentNotificationServiceRef;
}
export function setAgentNotificationServiceRef(
  v: typeof AgentNotificationServiceType | null
): void {
  agentNotificationServiceRef = v;
}
