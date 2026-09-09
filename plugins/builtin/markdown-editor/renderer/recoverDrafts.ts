import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { logError } from "@/utils/logger";
import { CHANNELS, PLUGIN_ID, PUSH_CHANNELS, type RecoverDraftPush } from "../shared/protocol.js";

/**
 * The renderer side of "Markdown: Recover drafts…" (#12323). Main lists the
 * drafts and asks; the project view that owns the draft's project answers by
 * opening the file panel in Edit mode — where the controller's normal load
 * finds the stored draft — and acknowledging the request so main stops
 * asking. Every project view receives the push; only the matching one acts.
 */
const handled = new Set<string>();

async function handle(push: RecoverDraftPush): Promise<void> {
  const project = useProjectStore.getState().currentProject;
  if (!project || project.id !== push.identity.projectId) return;
  if (handled.has(push.requestId)) return;
  handled.add(push.requestId);
  try {
    const result = await actionService.dispatch(
      "file.openPanel",
      {
        path: push.identity.filePath,
        rootPath: push.identity.worktreePath ?? project.path,
      },
      { source: "plugin" }
    );
    if (!result.ok) {
      logError("[markdown-editor] recover: file.openPanel failed", result.error);
      return;
    }
    const panelId = (result.result as { panelId?: string } | undefined)?.panelId;
    if (panelId) usePanelStore.getState().setFileViewMode(panelId, "edit");
    await window.electron.plugin.invoke(PLUGIN_ID, CHANNELS.recoverAck, {
      requestId: push.requestId,
    });
  } catch (error) {
    logError("[markdown-editor] recover failed", error);
  } finally {
    // Requests are one-shot; forget them once settled so the set stays small.
    setTimeout(() => handled.delete(push.requestId), 60_000);
  }
}

export function subscribeRecoverDrafts(): () => void {
  return window.electron.plugin.on(PLUGIN_ID, PUSH_CHANNELS.recoverDraft, (payload) => {
    const push = payload as RecoverDraftPush | null;
    if (!push || typeof push.requestId !== "string" || !push.identity) return;
    void handle(push);
  });
}
