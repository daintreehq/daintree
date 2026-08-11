import { webContents } from "electron";
import {
  RendererPanelProjectionPublishSchema,
  type RendererPanelProjectionPublish,
} from "../../../shared/types/ipc/remotePanelProjection.js";
import { remoteRendererPanelRegistry } from "../../services/remote/RemoteRendererPanelRegistry.js";
import { defineIpcNamespace, opValidated } from "../define.js";
import { REMOTE_PANEL_PROJECTION_METHOD_CHANNELS } from "./remotePanelProjection.preload.js";

export const remotePanelProjectionNamespace = defineIpcNamespace({
  name: "remotePanelProjection",
  ops: {
    publish: opValidated(
      REMOTE_PANEL_PROJECTION_METHOD_CHANNELS.publish,
      RendererPanelProjectionPublishSchema,
      (ctx, payload: RendererPanelProjectionPublish): void => {
        if (ctx.projectId !== payload.projectId) throw new Error("PROJECT_CONTEXT_MISMATCH");
        const sender = webContents.fromId(ctx.webContentsId);
        if (!sender) return;
        remoteRendererPanelRegistry.publish(payload, sender);
      },
      { withContext: true }
    ),
  },
});

export function registerRemotePanelProjectionHandlers(): () => void {
  return remotePanelProjectionNamespace.register();
}
