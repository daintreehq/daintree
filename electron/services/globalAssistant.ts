import path from "node:path";
import { app } from "electron";
import { NO_VIEW_HANDLE } from "../ipc/endpoint.js";
import {
  GLOBAL_ASSISTANT_DIR_NAME,
  GLOBAL_ASSISTANT_ID,
  GLOBAL_ASSISTANT_SLOT,
} from "../../shared/config/globalAssistant.js";
import { GlobalAssistantService, type GlobalAssistantDeps } from "./GlobalAssistantService.js";
import { onAgentDefaultsChanged } from "./agentDefaults.js";
import type { PtyClient } from "./PtyClient.js";
import { getWindowRegistry } from "../window/windowRef.js";

/** The deps the service runs with in the app, each service loaded on first use. */
export function liveGlobalAssistantDeps(): GlobalAssistantDeps {
  const help = () => import("./HelpSessionService.js").then((m) => m.helpSessionService);
  const launch = () => import("./assistants/assistantLaunch.js");
  const ptyClient = () => import("../window/serviceRefs.js").then((m) => m.getPtyClient());
  const folder = () => path.join(app.getPath("userData"), GLOBAL_ASSISTANT_DIR_NAME);

  return {
    agentId: async () => {
      const { liveAssistantLaunchDeps } = await launch();
      const agents = await (await liveAssistantLaunchDeps()).launchableAgents();
      return agents.find((agent) => agent.byDefault)?.id ?? null;
    },
    provision: async (agentId) => {
      const service = await help();
      return service.provisionSession({
        projectId: GLOBAL_ASSISTANT_ID,
        projectPath: folder(),
        agentId,
        slot: GLOBAL_ASSISTANT_SLOT,
        windowId: NO_VIEW_HANDLE,
        projectViewWebContentsId: NO_VIEW_HANDLE,
        global: true,
      });
    },
    takeResume: async () => {
      const service = await help();
      const taken = await service.takePendingHibernation(
        GLOBAL_ASSISTANT_ID,
        GLOBAL_ASSISTANT_SLOT
      );
      return taken
        ? { agentId: taken.agentId, agentSessionId: taken.agentSessionId, claimId: taken.claimId }
        : null;
    },
    releaseResume: async (claimId) => {
      const service = await help();
      await service.restorePendingHibernation(GLOBAL_ASSISTANT_ID, GLOBAL_ASSISTANT_SLOT, claimId);
    },
    discardResume: async () => {
      const service = await help();
      await service.discardConversation(GLOBAL_ASSISTANT_ID, GLOBAL_ASSISTANT_SLOT);
    },
    spawn: async (spec) => {
      const [{ spawnAndConfirm }, { spawnHostAssistantLive }, { liveAssistantLaunchDeps }, pty] =
        await Promise.all([launch(), import("./viewless/index.js"), launch(), ptyClient()]);
      const flags = await (
        await liveAssistantLaunchDeps()
      )
        .launchFlags(spec.agentId)
        .catch(() => []);
      const project = { id: GLOBAL_ASSISTANT_ID, path: folder() };
      return spawnAndConfirm(
        pty,
        () =>
          spawnHostAssistantLive(project, {
            terminalId: spec.terminalId,
            agentId: spec.agentId,
            cwd: spec.cwd,
            env: spec.env,
            prompt: "",
            agentLaunchFlags: flags,
            ...(spec.resumeAgentSessionId
              ? { resumeAgentSessionId: spec.resumeAgentSessionId }
              : {}),
          }),
        spec.terminalId
      );
    },
    revoke: async (sessionId, { capture }) => {
      const service = await help();
      await service.revokeSession(sessionId, capture ? { captureHibernation: true } : undefined);
    },
    kill: (terminalId) => {
      void ptyClient().then((pty) => pty?.kill(terminalId, "global-assistant-ended"));
    },
    focusedWindows: () =>
      (getWindowRegistry()?.focusOrder({ focusedOnly: true }) ?? [])
        .filter((ctx) => !ctx.browserWindow.isDestroyed())
        .map((ctx) => ctx.windowId),
  };
}

/**
 * Whenever input changes hands, drop whatever the PTY host still holds for the
 * run: a submit queued, or the Enter of one in flight, was the previous
 * owner's and must not land in the new owner's line (#14454). Main has already
 * refused anything the old owner sends from here on.
 */
export function fenceInputOnOwnerChange(
  service: GlobalAssistantService,
  ptyClient: () => Promise<Pick<PtyClient, "cancelPendingInput"> | null>
): void {
  let epoch = service.getState().inputEpoch;
  service.onChange((state) => {
    if (state.inputEpoch === epoch) return;
    epoch = state.inputEpoch;
    const terminalId = state.terminalId;
    if (!terminalId) return;
    void ptyClient().then((pty) => pty?.cancelPendingInput(terminalId));
  });
}

let instance: GlobalAssistantService | null = null;
let shuttingDown = false;

export function getGlobalAssistantService(): GlobalAssistantService {
  if (instance) return instance;
  const deps = liveGlobalAssistantDeps();
  const service = new GlobalAssistantService(deps);
  if (shuttingDown) service.closeAdmission();
  instance = service;
  onAgentDefaultsChanged(() => {
    void deps.agentId().then((agentId) => service.onAgentChanged(agentId));
  });
  void import("../window/serviceRefs.js").then(({ getPtyClient }) => {
    getPtyClient()?.on("exit", (id: string) => service.handleTerminalExit(id));
  });
  fenceInputOnOwnerChange(service, () =>
    import("../window/serviceRefs.js").then(({ getPtyClient }) => getPtyClient())
  );
  return instance;
}

/** Whether the service has been created; shutdown must not create it just to stop it. */
export function peekGlobalAssistantService(): GlobalAssistantService | null {
  return instance;
}

/**
 * Quit began. Latched whether or not the service exists yet, so a window that
 * asks for it afterwards finds admission closed instead of launching a run the
 * shutdown capture has already passed.
 */
export function beginGlobalAssistantShutdown(): Promise<void> {
  shuttingDown = true;
  return instance ? instance.shutdown() : Promise.resolve();
}
