import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteGatewayConfig,
} from "../../../shared/types/remote/index.js";
import { getFleetSnapshotService } from "../../ipc/handlers/projectCrud/index.js";
import { projectStore } from "../ProjectStore.js";
import { getWorkspaceClient } from "../WorkspaceClient.js";
import { getLifecycleLedger } from "../pty/lifecycleLedger.js";
import { getSharedDb } from "../persistence/db.js";
import { safeStorageCipher } from "../plugin/secretCipher.js";
import { RemoteAuthenticationService } from "./RemoteAuthenticationService.js";
import { RemoteAgentLaunchService } from "./RemoteAgentLaunchService.js";
import { createRemoteApplicationHandler } from "./RemoteApplicationHandler.js";
import { RemoteAuditService } from "./RemoteAuditService.js";
import { RemoteCapabilityService } from "./RemoteCapabilityService.js";
import { RemoteConsoleObservationService } from "./RemoteConsoleObservationService.js";
import { RemoteDiscoveryService } from "./RemoteDiscoveryService.js";
import { RemoteGatewayService } from "./RemoteGatewayService.js";
import { RemoteIdentityService } from "./RemoteIdentityService.js";
import { SqliteRemoteIdentityStore } from "./RemoteIdentityStore.js";
import { RemoteListener } from "./RemoteListener.js";
import { RemoteMutationLedgerService } from "./RemoteMutationLedgerService.js";
import { RemotePairingService } from "./RemotePairingService.js";
import { RemoteProtocolRouter } from "./RemoteProtocolRouter.js";
import { RemoteProjectProjectionService } from "./RemoteProjectProjectionService.js";
import { RemoteProjectViewBroker } from "./RemoteProjectViewBroker.js";
import { RemoteRendererBridge } from "./RemoteRendererBridge.js";
import { RemotePromptSubmissionService } from "./RemotePromptSubmissionService.js";
import { RemoteProjectDetailProjectionService } from "./RemoteProjectDetailProjectionService.js";
import { RemoteProjectDetailSubscriptionService } from "./RemoteProjectDetailSubscriptionService.js";
import { remoteRendererPanelRegistry } from "./RemoteRendererPanelRegistry.js";
import { RemoteSessionRegistry } from "./RemoteSessionRegistry.js";
import { RemoteTlsIdentityService } from "./RemoteTlsIdentityService.js";
import { getWindowRegistry } from "../../window/windowRef.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { store } from "../../store.js";
import { RemoteManagementService } from "./RemoteManagementService.js";

export interface RemoteRuntime {
  gateway: RemoteGatewayService;
  router: RemoteProtocolRouter;
  pairing: RemotePairingService;
  capabilities: RemoteCapabilityService;
  audit: RemoteAuditService;
  mutations: RemoteMutationLedgerService;
  projection: RemoteProjectProjectionService;
  detailProjection: RemoteProjectDetailProjectionService;
  projectViews: RemoteProjectViewBroker;
  rendererBridge: RemoteRendererBridge;
  detailSubscriptions: RemoteProjectDetailSubscriptionService;
  consoleObservation: RemoteConsoleObservationService;
  prompts: RemotePromptSubmissionService;
  launches: RemoteAgentLaunchService;
  management: RemoteManagementService;
  projectionCleanup: () => void;
}

let runtime: RemoteRuntime | null = null;

function createRemoteRuntime(appVersion: string): RemoteRuntime {
  const ptyClient = getPtyClient();
  if (!ptyClient) throw new Error("Remote gateway requires the initialized PTY client");
  const db = getSharedDb();
  const identityStore = new SqliteRemoteIdentityStore(db);
  const identity = new RemoteIdentityService(identityStore, safeStorageCipher);
  const tlsIdentity = new RemoteTlsIdentityService(identityStore, identity, safeStorageCipher);
  const sessions = new RemoteSessionRegistry();
  const authentication = new RemoteAuthenticationService(identityStore, identity);
  const pairing = new RemotePairingService(identityStore, identity, tlsIdentity);
  const capabilities = new RemoteCapabilityService(identityStore, identity, sessions);
  const router = new RemoteProtocolRouter(sessions, authentication, appVersion);
  router.setPairingService(pairing);
  const audit = new RemoteAuditService(db);
  const mutations = new RemoteMutationLedgerService(db);
  mutations.recoverInterrupted();
  const projection = new RemoteProjectProjectionService(projectStore, {
    getLastBroadcast: () => getFleetSnapshotService()?.getLastBroadcast() ?? null,
  });
  const detailProjection = new RemoteProjectDetailProjectionService(
    projectStore,
    getWorkspaceClient(),
    { getLastBroadcast: () => getFleetSnapshotService()?.getLastBroadcast() ?? null },
    remoteRendererPanelRegistry,
    getLifecycleLedger()
  );
  const projectViews = new RemoteProjectViewBroker(
    projectStore,
    () => getWindowRegistry()?.focusOrder() ?? [],
    remoteRendererPanelRegistry,
    undefined,
    undefined,
    getWorkspaceClient()
  );
  const rendererBridge = new RemoteRendererBridge(remoteRendererPanelRegistry);
  rendererBridge.start();
  const detailSubscriptions = new RemoteProjectDetailSubscriptionService(
    detailProjection,
    sessions,
    (session, update) => {
      router.sendApplicationEnvelope(session.connection.id, {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        sessionId: session.id,
        kind: "event",
        type: "project.updated",
        revision: update.revision,
        payload: update,
      });
    }
  );
  const consoleObservation = new RemoteConsoleObservationService(
    detailProjection,
    ptyClient,
    sessions,
    router
  );
  const prompts = new RemotePromptSubmissionService(
    detailProjection,
    ptyClient,
    capabilities,
    sessions,
    mutations,
    audit,
    router
  );
  const launches = new RemoteAgentLaunchService(
    detailProjection,
    projectViews,
    rendererBridge,
    capabilities,
    sessions,
    mutations,
    audit,
    router
  );
  router.setAuditService(audit);
  pairing.setAuditService(audit);
  capabilities.setAuditService(audit);
  router.setApplicationHandler(
    createRemoteApplicationHandler({
      projection,
      detailProjection,
      detailSubscriptions,
      projectViews,
      consoleObservation,
      prompts,
      launches,
      sender: router,
    })
  );
  const projectionCleanup = projection.subscribe((update) => {
    if (update.kind !== "delta") return;
    for (const session of sessions.readySessions()) {
      if (!session.capabilities.includes("observe-projects")) continue;
      router.sendApplicationEnvelope(session.connection.id, {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        sessionId: session.id,
        kind: "event",
        type: "projects.updated",
        revision: update.value.revision,
        payload: update.value,
      });
    }
  });
  const gateway = new RemoteGatewayService(
    new RemoteListener(),
    router,
    tlsIdentity,
    pairing,
    authentication,
    new RemoteDiscoveryService(identity, tlsIdentity, appVersion)
  );
  const management = new RemoteManagementService(
    identityStore,
    safeStorageCipher,
    gateway,
    pairing,
    capabilities,
    sessions,
    audit,
    {
      get: () => store.get("remoteAccess"),
      set: (config) => store.set("remoteAccess", config),
    },
    async (config) => {
      await gateway.applyConfig(config);
      if (config.enabled) projection.start();
      else projection.stop();
      if (config.enabled) detailSubscriptions.start();
      else detailSubscriptions.stop();
    }
  );
  return {
    gateway,
    router,
    pairing,
    capabilities,
    audit,
    mutations,
    projection,
    detailProjection,
    projectViews,
    rendererBridge,
    detailSubscriptions,
    consoleObservation,
    prompts,
    launches,
    management,
    projectionCleanup,
  };
}

export async function initializeRemoteGateway(
  config: RemoteGatewayConfig,
  appVersion: string
): Promise<RemoteRuntime> {
  runtime ??= createRemoteRuntime(appVersion);
  await runtime.gateway.applyConfig(config);
  if (config.enabled) runtime.projection.start();
  else runtime.projection.stop();
  if (config.enabled) runtime.detailSubscriptions.start();
  else runtime.detailSubscriptions.stop();
  return runtime;
}

export function getRemoteRuntime(): RemoteRuntime | null {
  return runtime;
}

export async function disposeRemoteGateway(): Promise<void> {
  if (!runtime) return;
  const current = runtime;
  runtime = null;
  current.projectionCleanup();
  current.projection.stop();
  current.detailSubscriptions.stop();
  current.consoleObservation.dispose();
  current.projectViews.dispose();
  current.rendererBridge.dispose();
  remoteRendererPanelRegistry.clear();
  await current.gateway.stop();
}
