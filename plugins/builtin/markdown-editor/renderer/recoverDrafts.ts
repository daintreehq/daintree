import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useFileDocumentStore } from "@/store/fileDocumentStore";
import { logError } from "@/utils/logger";
import {
  CHANNELS,
  identityKey,
  PLUGIN_ID,
  PUSH_CHANNELS,
  type RecoverDraftPush,
} from "../shared/protocol.js";

const DRAFT_LOAD_TIMEOUT_MS = 5000;

/**
 * Resolves once the panel's editor publishes a projection for exactly the
 * draft's identity — the moment the stored draft has been found — or false
 * when it never does. Acknowledging earlier would tell main the draft was
 * recovered when the panel may have opened a different document (a worktree
 * that no longer exists resolves to a different identity).
 */
function waitForDraft(panelId: string, key: string): Promise<boolean> {
  const matches = () => {
    const projection = useFileDocumentStore.getState().byPanelId[panelId];
    // The identity is published before the stored draft is read; the draft
    // has actually been recovered once the projection turns dirty.
    return projection?.identityKey === key && projection.dirty;
  };
  if (matches()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, DRAFT_LOAD_TIMEOUT_MS);
    const unsubscribe = useFileDocumentStore.subscribe(() => {
      if (!matches()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

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
    if (!panelId) return;
    usePanelStore.getState().setFileViewMode(panelId, "edit");
    // Only a panel that ended up on the draft's own document counts; main
    // keeps asking (and finally says where the draft is) otherwise.
    const loaded = await waitForDraft(panelId, identityKey(push.identity));
    if (!loaded) return;
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
